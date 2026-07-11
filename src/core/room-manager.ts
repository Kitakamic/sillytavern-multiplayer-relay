import WebSocket from 'ws';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
    createAck, createError, createEvent, createTransientEvent, serialize,
    CommandType, ErrorCode, EventType,
    type ClientCommand, type RelayMessage,
} from './protocol.js';
import type { RelayConfig } from './config.js';
import type { MemberRole, ProposalRecord, RoomRecord, RoomStore, StoredEvent } from './room-store.js';
import type { AssetStore } from './asset-store.js';

const DISPLAY_NAME_MAX_LENGTH = 50;
const STORY_TEXT_MAX_LENGTH = 8000;
const SIDECHAT_TEXT_MAX_LENGTH = 2000;
const REJECT_REASON_MAX_LENGTH = 500;

class CommandError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

/** Constant-time secret comparison that tolerates differing lengths. */
function secretsMatch(expected: string, provided: string): boolean {
    const a = createHash('sha256').update(expected).digest();
    const b = createHash('sha256').update(provided).digest();
    return timingSafeEqual(a, b);
}

export class RelaySession {
    /** Set by auth.hello; null until the connection has identified itself. */
    clientId: string | null = null;

    constructor(public readonly socket: WebSocket) {}

    send(message: RelayMessage): void {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(serialize(message));
        }
    }
}

/**
 * Server-side identity issued by auth.hello. Survives socket churn so that
 * a reconnecting client keeps its clientId and room membership; lost on
 * relay restart together with the in-memory store.
 */
type Identity = {
    clientId: string;
    sessionToken: string;
    displayName: string;
    roomId: string | null;
    role: MemberRole | null;
};

/**
 * Transport-safe command boundary: room commands, invitation issuance, and
 * role enforcement run here against the injected RoomStore, never inside
 * WebSocket handlers.
 */
export class RoomManager {
    #identities = new Map<string, Identity>();
    /** clientId → the one live session currently speaking for it. */
    #liveSessions = new Map<string, RelaySession>();
    /** roomId → true while the host has an AI generation in flight (runtime state, not logged). */
    #generating = new Map<string, boolean>();

    constructor(
        private readonly store: RoomStore,
        private readonly assetStore: AssetStore,
        private readonly config: RelayConfig,
    ) {}

    /**
     * HTTP asset-channel auth (M2.5): validates session credentials and room
     * membership. Returns the member's role and the room's expiry so the
     * caller can cap asset TTLs.
     */
    async authorizeAssetAccess(clientId: string, sessionToken: string, roomId: string): Promise<
        { role: MemberRole; roomExpiresAt: number } | 'unauthorized' | 'forbidden'
    > {
        const identity = this.#identities.get(clientId);
        if (!identity || !secretsMatch(identity.sessionToken, sessionToken)) return 'unauthorized';
        const room = await this.#getLiveRoom(roomId);
        if (!room) return 'forbidden';
        const member = await this.store.getMember(roomId, clientId);
        if (!member) return 'forbidden';
        return { role: member.role, roomExpiresAt: room.expiresAt };
    }

    async handle(session: RelaySession, command: ClientCommand): Promise<void> {
        try {
            await this.#dispatch(session, command);
        } catch (error) {
            if (error instanceof CommandError) {
                session.send(createError(error.message, command.requestId, error.code));
                return;
            }
            console.error(`[relay] command '${command.type}' failed:`, error);
            session.send(createError('Internal relay error.', command.requestId, ErrorCode.INTERNAL));
        }
    }

    /** Socket closed: mark the member offline, but keep identity and membership. */
    handleDisconnect(session: RelaySession): void {
        const clientId = session.clientId;
        if (!clientId || this.#liveSessions.get(clientId) !== session) return;
        this.#liveSessions.delete(clientId);

        const identity = this.#identities.get(clientId);
        if (identity?.roomId) {
            void this.#publishEvent(identity.roomId, EventType.ROOM_MEMBER_OFFLINE, { clientId })
                .catch((error) => console.error('[relay] offline broadcast failed:', error));
        }
    }

    async #dispatch(session: RelaySession, command: ClientCommand): Promise<void> {
        switch (command.type) {
            case CommandType.RELAY_PING:
                session.send(createAck(command, { serverTime: new Date().toISOString() }));
                return;
            case CommandType.AUTH_HELLO:
                return this.#handleHello(session, command);
        }

        const identity = this.#requireIdentity(session);
        switch (command.type) {
            case CommandType.ROOM_CREATE:
                return this.#handleRoomCreate(session, identity, command);
            case CommandType.ROOM_JOIN:
                return this.#handleRoomJoin(session, identity, command);
            case CommandType.ROOM_LEAVE:
                return this.#handleRoomLeave(session, identity, command);
            case CommandType.ROOM_KICK:
                return this.#handleRoomKick(session, identity, command);
            case CommandType.ROOM_RESUME:
                return this.#handleRoomResume(session, identity, command);
            case CommandType.ROOM_CARD_UPDATE:
                return this.#handleRoomCardUpdate(session, identity, command);
            case CommandType.ROOM_CARD_CLEAR:
                return this.#handleRoomCardClear(session, identity, command);
            case CommandType.PROPOSAL_SUBMIT:
                return this.#handleProposalSubmit(session, identity, command);
            case CommandType.PROPOSAL_WITHDRAW:
                return this.#handleProposalWithdraw(session, identity, command);
            case CommandType.PROPOSAL_ACCEPT:
                return this.#handleProposalDecision(session, identity, command, 'accepted');
            case CommandType.PROPOSAL_REJECT:
                return this.#handleProposalDecision(session, identity, command, 'rejected');
            case CommandType.STORY_MESSAGE_PUBLISH:
                return this.#handleStoryPublish(session, identity, command);
            case CommandType.SIDECHAT_MESSAGE_POST:
                return this.#handleSidechatPost(session, identity, command);
            case CommandType.GENERATION_START:
            case CommandType.GENERATION_PROGRESS:
            case CommandType.GENERATION_FINISH:
                return this.#handleGeneration(session, identity, command);
        }

        throw new CommandError(ErrorCode.UNKNOWN_COMMAND, `Command '${command.type}' is not recognized.`);
    }

    async #handleHello(session: RelaySession, command: ClientCommand): Promise<void> {
        const payload = command.payload ?? {};
        const displayName = this.#requireDisplayName(payload.displayName);

        // Resume path: valid clientId + sessionToken re-binds the existing identity.
        const { clientId, sessionToken } = payload;
        if (typeof clientId === 'string' && typeof sessionToken === 'string') {
            const identity = this.#identities.get(clientId);
            if (identity && secretsMatch(identity.sessionToken, sessionToken)) {
                identity.displayName = displayName;
                this.#bindSession(session, identity.clientId);

                let room: Record<string, unknown> | null = null;
                if (identity.roomId) {
                    const membership = await this.#refreshMembership(identity);
                    if (membership) {
                        room = { roomId: membership.roomId, role: membership.role, generating: this.#generating.get(membership.roomId) ?? false };
                        session.send(createAck(command, { clientId: identity.clientId, sessionToken: identity.sessionToken, room }));
                        await this.#publishEvent(membership.roomId, EventType.ROOM_MEMBER_ONLINE, { clientId: identity.clientId });
                        return;
                    }
                }
                session.send(createAck(command, { clientId: identity.clientId, sessionToken: identity.sessionToken, room }));
                return;
            }
            // Stale or forged credentials: fall through and issue a fresh identity
            // (the client cannot repair the old one anyway).
        }

        const identity: Identity = {
            clientId: randomUUID(),
            sessionToken: randomBytes(32).toString('base64url'),
            displayName,
            roomId: null,
            role: null,
        };
        this.#identities.set(identity.clientId, identity);
        this.#bindSession(session, identity.clientId);
        session.send(createAck(command, { clientId: identity.clientId, sessionToken: identity.sessionToken, room: null }));
    }

    async #handleRoomCreate(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        if (identity.roomId) throw new CommandError(ErrorCode.ALREADY_IN_ROOM, 'Leave the current room first.');

        const creatorKey = (command.payload ?? {}).creatorKey;
        if (typeof creatorKey !== 'string' || !creatorKey || !secretsMatch(this.config.creatorKey, creatorKey)) {
            throw new CommandError(ErrorCode.CREATOR_KEY_INVALID, 'Creator key is missing or wrong.');
        }

        const now = Date.now();
        const room: RoomRecord = {
            roomId: randomBytes(8).toString('base64url'),
            hostClientId: identity.clientId,
            createdAt: now,
            expiresAt: now + this.config.roomTtlHours * 3_600_000,
        };
        const invite = {
            token: randomBytes(24).toString('base64url'),
            expiresAt: Math.min(now + this.config.inviteTtlHours * 3_600_000, room.expiresAt),
            usesLeft: this.config.maxRoomMembers - 1,
        };

        await this.store.createRoom(room);
        await this.store.setInvite(room.roomId, invite);
        await this.store.addMember(room.roomId, {
            clientId: identity.clientId,
            displayName: identity.displayName,
            role: 'host',
            joinedAt: now,
        }, this.config.maxRoomMembers);

        identity.roomId = room.roomId;
        identity.role = 'host';

        session.send(createAck(command, {
            roomId: room.roomId,
            roomExpiresAt: room.expiresAt,
            inviteToken: invite.token,
            inviteExpiresAt: invite.expiresAt,
            inviteMaxUses: invite.usesLeft,
            members: await this.#membersWithPresence(room.roomId),
        }));
        await this.#publishEvent(room.roomId, EventType.ROOM_MEMBER_JOINED, {
            member: { clientId: identity.clientId, displayName: identity.displayName, role: 'host', joinedAt: now },
        }, command.opId);
    }

    async #handleRoomJoin(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const payload = command.payload ?? {};
        const { roomId, token } = payload;
        if (typeof roomId !== 'string' || !roomId || typeof token !== 'string' || !token) {
            throw new CommandError(ErrorCode.BAD_PAYLOAD, 'roomId and token are required.');
        }

        // Ack-lost retry: already a member of this exact room is a success, not an error.
        if (identity.roomId === roomId && await this.store.getMember(roomId, identity.clientId)) {
            session.send(createAck(command, { roomId, role: identity.role, members: await this.#membersWithPresence(roomId) }));
            return;
        }
        if (identity.roomId) throw new CommandError(ErrorCode.ALREADY_IN_ROOM, 'Leave the current room first.');

        const room = await this.#getLiveRoom(roomId);
        if (!room) throw new CommandError(ErrorCode.ROOM_NOT_FOUND, 'Room not found or expired.');

        const invite = await this.store.getInvite(roomId);
        if (!invite || invite.expiresAt <= Date.now() || !secretsMatch(invite.token, token)) {
            throw new CommandError(ErrorCode.INVITE_INVALID, 'Invite is invalid or expired.');
        }

        try {
            await this.store.consumeInviteUse(roomId);
        } catch {
            throw new CommandError(ErrorCode.INVITE_INVALID, 'Invite has no uses left.');
        }

        const member = {
            clientId: identity.clientId,
            displayName: identity.displayName,
            role: 'guest' as const,
            joinedAt: Date.now(),
        };
        try {
            await this.store.addMember(roomId, member, this.config.maxRoomMembers);
        } catch {
            throw new CommandError(ErrorCode.ROOM_FULL, 'Room is full.');
        }

        identity.roomId = roomId;
        identity.role = 'guest';

        session.send(createAck(command, { roomId, role: 'guest', members: await this.#membersWithPresence(roomId) }));
        await this.#publishEvent(roomId, EventType.ROOM_MEMBER_JOINED, { member }, command.opId);
    }

    async #handleRoomLeave(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = identity.roomId;
        if (!roomId) throw new CommandError(ErrorCode.NOT_IN_ROOM, 'Not in a room.');

        if (identity.role === 'host') {
            await this.#closeRoom(roomId, 'host_left');
        } else {
            await this.store.removeMember(roomId, identity.clientId);
            identity.roomId = null;
            identity.role = null;
            await this.#publishEvent(roomId, EventType.ROOM_MEMBER_LEFT, { clientId: identity.clientId, reason: 'left' }, command.opId);
        }
        session.send(createAck(command, {}));
    }

    async #handleRoomKick(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = identity.roomId;
        if (!roomId) throw new CommandError(ErrorCode.NOT_IN_ROOM, 'Not in a room.');
        if (identity.role !== 'host') throw new CommandError(ErrorCode.FORBIDDEN, 'Only the host may kick.');

        const target = (command.payload ?? {}).clientId;
        if (typeof target !== 'string' || !target) throw new CommandError(ErrorCode.BAD_PAYLOAD, 'clientId is required.');
        if (target === identity.clientId) throw new CommandError(ErrorCode.BAD_PAYLOAD, 'Use room.leave to leave your own room.');

        const member = await this.store.getMember(roomId, target);
        if (!member) throw new CommandError(ErrorCode.TARGET_NOT_FOUND, 'No such member.');

        // Publish before removing so the kicked client still receives the event.
        await this.#publishEvent(roomId, EventType.ROOM_MEMBER_LEFT, { clientId: target, reason: 'kicked' }, command.opId);
        await this.store.removeMember(roomId, target);

        const targetIdentity = this.#identities.get(target);
        if (targetIdentity?.roomId === roomId) {
            targetIdentity.roomId = null;
            targetIdentity.role = null;
        }
        session.send(createAck(command, {}));
    }

    /** Reconnect catch-up: replays every logged event after the client's lastAppliedSeq. */
    async #handleRoomResume(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const lastAppliedSeq = (command.payload ?? {}).lastAppliedSeq;
        if (!Number.isInteger(lastAppliedSeq) || (lastAppliedSeq as number) < 0) {
            throw new CommandError(ErrorCode.BAD_PAYLOAD, 'lastAppliedSeq must be a non-negative integer.');
        }

        const membership = await this.#refreshMembership(identity);
        if (!membership) throw new CommandError(ErrorCode.NOT_IN_ROOM, 'Not in a room (it may have closed while you were away).');
        const { roomId, role } = membership;

        const missed = await this.store.listEventsAfter(roomId, lastAppliedSeq as number);
        session.send(createAck(command, {
            roomId,
            role,
            generating: this.#generating.get(roomId) ?? false,
            lastSeq: missed.length ? missed[missed.length - 1].seq : lastAppliedSeq,
            members: await this.#membersWithPresence(roomId),
            events: missed.map((event) => createEvent(event.type, roomId, event.seq, event.payload)),
        }));
    }

    /** Publishes an already-uploaded full character-card asset to the room. */
    async #handleRoomCardUpdate(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        this.#requireHost(identity);
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const payload = command.payload ?? {};
        const assetId = this.#requireText(payload.assetId, 100, 'assetId');
        const characterName = this.#requireText(payload.characterName, 100, 'characterName');
        const asset = await this.assetStore.getAsset(roomId, assetId);
        if (!asset || asset.record.expiresAt <= Date.now()) {
            if (asset) await this.assetStore.deleteAsset(roomId, assetId);
            throw new CommandError(ErrorCode.ASSET_NOT_FOUND, 'Character card asset was not found or has expired.');
        }
        if (asset.record.kind !== 'card' || asset.record.uploaderClientId !== identity.clientId) {
            throw new CommandError(ErrorCode.FORBIDDEN, 'Only the host may publish its own character-card asset.');
        }

        const eventPayload = {
            assetId,
            characterName,
            bytes: asset.record.bytes,
            expiresAt: asset.record.expiresAt,
            sharedAt: Date.now(),
        };
        await this.#finishOp(session, roomId, command, eventPayload);
        await this.#publishEvent(roomId, EventType.ROOM_CARD_UPDATED, eventPayload, command.opId);
    }

    /** Revokes a shared card immediately and tells clients to drop the projection. */
    async #handleRoomCardClear(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        this.#requireHost(identity);
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const assetId = this.#requireText((command.payload ?? {}).assetId, 100, 'assetId');
        const asset = await this.assetStore.getAsset(roomId, assetId);
        if (asset && (asset.record.kind !== 'card' || asset.record.uploaderClientId !== identity.clientId)) {
            throw new CommandError(ErrorCode.FORBIDDEN, 'Only the host may revoke its own character-card asset.');
        }

        await this.assetStore.deleteAsset(roomId, assetId);
        await this.#finishOp(session, roomId, command, { assetId });
        await this.#publishEvent(roomId, EventType.ROOM_CARD_CLEARED, { assetId }, command.opId);
    }

    async #handleProposalSubmit(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        if (identity.role !== 'guest') {
            throw new CommandError(ErrorCode.FORBIDDEN, 'Only guests submit proposals; the host writes directly.');
        }
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const text = this.#requireText((command.payload ?? {}).text, STORY_TEXT_MAX_LENGTH, 'text');
        const now = Date.now();
        const proposal: ProposalRecord = {
            proposalId: randomUUID(),
            authorClientId: identity.clientId,
            authorDisplayName: identity.displayName,
            text,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        };
        await this.store.addProposal(roomId, proposal);
        await this.#finishOp(session, roomId, command, { proposalId: proposal.proposalId });
        await this.#publishEvent(roomId, EventType.PROPOSAL_SUBMITTED, {
            proposal: {
                proposalId: proposal.proposalId,
                authorClientId: proposal.authorClientId,
                authorDisplayName: proposal.authorDisplayName,
                text: proposal.text,
                submittedAt: now,
            },
        }, command.opId);
    }

    async #handleProposalWithdraw(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const proposalId = this.#requireText((command.payload ?? {}).proposalId, 100, 'proposalId');
        const proposal = await this.store.getProposal(roomId, proposalId);
        if (!proposal) throw new CommandError(ErrorCode.TARGET_NOT_FOUND, 'No such proposal.');
        if (proposal.authorClientId !== identity.clientId) {
            throw new CommandError(ErrorCode.FORBIDDEN, 'Only the author may withdraw a proposal.');
        }
        await this.#transitionOrThrow(roomId, proposalId, 'withdrawn');

        await this.#finishOp(session, roomId, command, { proposalId });
        await this.#publishEvent(roomId, EventType.PROPOSAL_WITHDRAWN, { proposalId, clientId: identity.clientId }, command.opId);
    }

    async #handleProposalDecision(session: RelaySession, identity: Identity, command: ClientCommand, status: 'accepted' | 'rejected'): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        this.#requireHost(identity);
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const payload = command.payload ?? {};
        const proposalId = this.#requireText(payload.proposalId, 100, 'proposalId');
        const proposal = await this.store.getProposal(roomId, proposalId);
        if (!proposal) throw new CommandError(ErrorCode.TARGET_NOT_FOUND, 'No such proposal.');
        await this.#transitionOrThrow(roomId, proposalId, status);

        const eventPayload: Record<string, unknown> = { proposalId };
        if (status === 'rejected' && typeof payload.reason === 'string' && payload.reason.trim()) {
            eventPayload.reason = payload.reason.trim().slice(0, REJECT_REASON_MAX_LENGTH);
        }
        await this.#finishOp(session, roomId, command, { proposalId });
        await this.#publishEvent(
            roomId,
            status === 'accepted' ? EventType.PROPOSAL_ACCEPTED : EventType.PROPOSAL_REJECTED,
            eventPayload,
            command.opId,
        );
    }

    async #handleStoryPublish(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        this.#requireHost(identity);
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const payload = command.payload ?? {};
        const text = this.#requireText(payload.text, STORY_TEXT_MAX_LENGTH, 'text');
        const authorName = this.#requireText(payload.authorName, DISPLAY_NAME_MAX_LENGTH, 'authorName');
        if (payload.role !== 'user' && payload.role !== 'assistant') {
            throw new CommandError(ErrorCode.BAD_PAYLOAD, "role must be 'user' or 'assistant'.");
        }

        const message: Record<string, unknown> = {
            messageId: randomUUID(),
            authorName,
            role: payload.role,
            text,
            publishedAt: Date.now(),
        };
        if (typeof payload.proposalId === 'string' && payload.proposalId) message.proposalId = payload.proposalId;

        const stored = await this.#publishEvent(roomId, EventType.STORY_MESSAGE_PUBLISHED, { message }, command.opId);
        await this.#finishOp(session, roomId, command, { messageId: message.messageId, seq: stored.seq });
    }

    async #handleSidechatPost(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        if (await this.#replayCachedAck(session, roomId, command)) return;

        const text = this.#requireText((command.payload ?? {}).text, SIDECHAT_TEXT_MAX_LENGTH, 'text');
        const message = {
            messageId: randomUUID(),
            authorClientId: identity.clientId,
            authorDisplayName: identity.displayName,
            text,
            postedAt: Date.now(),
        };
        await this.#finishOp(session, roomId, command, { messageId: message.messageId });
        await this.#publishEvent(roomId, EventType.SIDECHAT_MESSAGE_POSTED, { message }, command.opId);
    }

    /** generation.* status is transient: broadcast without seq, tracked only as a runtime flag. */
    async #handleGeneration(session: RelaySession, identity: Identity, command: ClientCommand): Promise<void> {
        const roomId = this.#requireRoomId(identity);
        this.#requireHost(identity);
        const payload = command.payload ?? {};

        let type: string;
        let eventPayload: Record<string, unknown> = {};
        if (command.type === CommandType.GENERATION_START) {
            this.#generating.set(roomId, true);
            type = EventType.GENERATION_STARTED;
        } else if (command.type === CommandType.GENERATION_PROGRESS) {
            if (payload.charCount !== undefined && (typeof payload.charCount !== 'number' || payload.charCount < 0)) {
                throw new CommandError(ErrorCode.BAD_PAYLOAD, 'charCount must be a non-negative number.');
            }
            if (payload.charCount !== undefined) eventPayload = { charCount: payload.charCount };
            type = EventType.GENERATION_PROGRESSED;
        } else {
            if (payload.ok !== undefined && typeof payload.ok !== 'boolean') {
                throw new CommandError(ErrorCode.BAD_PAYLOAD, 'ok must be a boolean.');
            }
            this.#generating.delete(roomId);
            type = EventType.GENERATION_FINISHED;
            eventPayload = { ok: payload.ok ?? true };
        }

        session.send(createAck(command, {}));
        await this.#broadcastTransient(roomId, type, eventPayload);
    }

    /** Broadcasts room.closed, detaches every member identity, and deletes the room. */
    async #closeRoom(roomId: string, reason: 'host_left' | 'expired'): Promise<void> {
        await this.#publishEvent(roomId, EventType.ROOM_CLOSED, { reason });
        for (const member of await this.store.listMembers(roomId)) {
            const identity = this.#identities.get(member.clientId);
            if (identity?.roomId === roomId) {
                identity.roomId = null;
                identity.role = null;
            }
        }
        this.#generating.delete(roomId);
        await this.assetStore.deleteRoomAssets(roomId);
        await this.store.deleteRoom(roomId);
    }

    /** Appends to the room log and fans the event out to every online member. */
    async #publishEvent(roomId: string, type: string, payload: Record<string, unknown>, opId: string = randomUUID()): Promise<StoredEvent> {
        const stored = await this.store.appendEvent(roomId, { type, payload, opId, createdAt: Date.now() });
        const message = createEvent(type, roomId, stored.seq, payload);
        for (const member of await this.store.listMembers(roomId)) {
            this.#liveSessions.get(member.clientId)?.send(message);
        }
        return stored;
    }

    /** Fans out a seq-less event to online members without touching the room log. */
    async #broadcastTransient(roomId: string, type: string, payload: Record<string, unknown>): Promise<void> {
        const message = createTransientEvent(type, roomId, payload);
        for (const member of await this.store.listMembers(roomId)) {
            this.#liveSessions.get(member.clientId)?.send(message);
        }
    }

    /** Returns the room if it exists and is unexpired; closes it lazily otherwise. */
    async #getLiveRoom(roomId: string): Promise<RoomRecord | null> {
        const room = await this.store.getRoom(roomId);
        if (!room) return null;
        if (room.expiresAt <= Date.now()) {
            await this.#closeRoom(roomId, 'expired');
            return null;
        }
        return room;
    }

    /** Re-validates a resumed identity's membership; clears it if the room or seat is gone. */
    async #refreshMembership(identity: Identity): Promise<{ roomId: string; role: MemberRole } | null> {
        const roomId = identity.roomId;
        if (!roomId) return null;
        const room = await this.#getLiveRoom(roomId);
        const member = room ? await this.store.getMember(roomId, identity.clientId) : null;
        if (!member) {
            identity.roomId = null;
            identity.role = null;
            return null;
        }
        return { roomId, role: member.role };
    }

    async #membersWithPresence(roomId: string): Promise<Record<string, unknown>[]> {
        const members = await this.store.listMembers(roomId);
        return members.map((member) => ({ ...member, online: this.#liveSessions.has(member.clientId) }));
    }

    /** Makes this socket the sole live session for the client, displacing any zombie. */
    #bindSession(session: RelaySession, clientId: string): void {
        const previous = this.#liveSessions.get(clientId);
        if (previous && previous !== session) {
            previous.clientId = null;
            try { previous.socket.close(4000, 'Session replaced by a newer connection'); } catch { /* already gone */ }
        }
        session.clientId = clientId;
        this.#liveSessions.set(clientId, session);
    }

    #requireIdentity(session: RelaySession): Identity {
        const identity = session.clientId ? this.#identities.get(session.clientId) : undefined;
        if (!identity) throw new CommandError(ErrorCode.NOT_AUTHENTICATED, 'Send auth.hello first.');
        return identity;
    }

    #requireRoomId(identity: Identity): string {
        if (!identity.roomId) throw new CommandError(ErrorCode.NOT_IN_ROOM, 'Not in a room.');
        return identity.roomId;
    }

    #requireHost(identity: Identity): void {
        if (identity.role !== 'host') throw new CommandError(ErrorCode.FORBIDDEN, 'Host-only command.');
    }

    #requireText(value: unknown, maxLength: number, field: string): string {
        if (typeof value !== 'string') throw new CommandError(ErrorCode.BAD_PAYLOAD, `${field} is required.`);
        const text = value.trim();
        if (!text || text.length > maxLength) {
            throw new CommandError(ErrorCode.BAD_PAYLOAD, `${field} must be 1-${maxLength} characters.`);
        }
        return text;
    }

    /** Idempotent retry: if this opId already produced an ack, resend it and skip the mutation. */
    async #replayCachedAck(session: RelaySession, roomId: string, command: ClientCommand): Promise<boolean> {
        const cached = await this.store.getOpResult(roomId, command.opId);
        if (!cached) return false;
        session.send(createAck(command, cached));
        return true;
    }

    async #finishOp(session: RelaySession, roomId: string, command: ClientCommand, ackPayload: Record<string, unknown>): Promise<void> {
        await this.store.putOpResult(roomId, command.opId, ackPayload);
        session.send(createAck(command, ackPayload));
    }

    async #transitionOrThrow(roomId: string, proposalId: string, status: 'accepted' | 'rejected' | 'withdrawn'): Promise<void> {
        try {
            await this.store.transitionProposal(roomId, proposalId, status);
        } catch {
            throw new CommandError(ErrorCode.PROPOSAL_NOT_PENDING, 'Proposal is no longer pending.');
        }
    }

    #requireDisplayName(value: unknown): string {
        if (typeof value !== 'string') throw new CommandError(ErrorCode.BAD_PAYLOAD, 'displayName is required.');
        const displayName = value.trim();
        if (!displayName || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
            throw new CommandError(ErrorCode.BAD_PAYLOAD, `displayName must be 1-${DISPLAY_NAME_MAX_LENGTH} characters.`);
        }
        return displayName;
    }
}
