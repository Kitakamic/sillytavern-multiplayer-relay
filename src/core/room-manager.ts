import WebSocket from 'ws';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
    createAck, createError, createEvent, serialize,
    CommandType, ErrorCode, EventType,
    type ClientCommand, type RelayMessage,
} from './protocol.js';
import type { RelayConfig } from './config.js';
import type { MemberRole, RoomRecord, RoomStore } from './room-store.js';

const DISPLAY_NAME_MAX_LENGTH = 50;

/** Commands whose vocabulary exists but whose behavior lands with milestone M2. */
const M2_COMMANDS: ReadonlySet<string> = new Set([
    CommandType.ROOM_RESUME,
    CommandType.PROPOSAL_SUBMIT,
    CommandType.PROPOSAL_WITHDRAW,
    CommandType.PROPOSAL_ACCEPT,
    CommandType.PROPOSAL_REJECT,
    CommandType.STORY_MESSAGE_PUBLISH,
    CommandType.SIDECHAT_MESSAGE_POST,
    CommandType.GENERATION_START,
    CommandType.GENERATION_PROGRESS,
    CommandType.GENERATION_FINISH,
]);

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

    constructor(
        private readonly store: RoomStore,
        private readonly config: RelayConfig,
    ) {}

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
        }

        if (M2_COMMANDS.has(command.type)) {
            throw new CommandError(ErrorCode.NOT_IMPLEMENTED, `Command '${command.type}' arrives with milestone M2.`);
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
                        room = { roomId: membership.roomId, role: membership.role };
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
        await this.store.deleteRoom(roomId);
    }

    /** Appends to the room log and fans the event out to every online member. */
    async #publishEvent(roomId: string, type: string, payload: Record<string, unknown>, opId: string = randomUUID()): Promise<void> {
        const stored = await this.store.appendEvent(roomId, { type, payload, opId, createdAt: Date.now() });
        const message = createEvent(type, roomId, stored.seq, payload);
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

    #requireDisplayName(value: unknown): string {
        if (typeof value !== 'string') throw new CommandError(ErrorCode.BAD_PAYLOAD, 'displayName is required.');
        const displayName = value.trim();
        if (!displayName || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
            throw new CommandError(ErrorCode.BAD_PAYLOAD, `displayName must be 1-${DISPLAY_NAME_MAX_LENGTH} characters.`);
        }
        return displayName;
    }
}
