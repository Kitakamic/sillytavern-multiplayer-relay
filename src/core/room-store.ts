/**
 * Persistence boundary for rooms and their ordered event logs.
 * The in-memory implementation serves V1; this interface is the seam
 * for a durable (e.g. SQLite) implementation later.
 */
export type RoomRecord = {
    roomId: string;
    hostClientId: string;
    createdAt: number;
    /** Absolute ms timestamp after which the room may be purged. */
    expiresAt: number;
};

/** Single limited-use invite per room, issued at room.create (M1). */
export type RoomInvite = {
    token: string;
    /** Absolute ms timestamp; the token stops working afterwards. */
    expiresAt: number;
    usesLeft: number;
};

export type MemberRole = 'host' | 'guest';

export type RoomMember = {
    clientId: string;
    displayName: string;
    role: MemberRole;
    joinedAt: number;
};

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

export type ProposalRecord = {
    proposalId: string;
    authorClientId: string;
    authorDisplayName: string;
    text: string;
    status: ProposalStatus;
    createdAt: number;
    updatedAt: number;
};

export type StoredEvent = {
    /** Monotonically increasing, per-room. The relay is the ordering authority. */
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    /** opId of the command that produced this event, for idempotent replays. */
    opId: string;
    createdAt: number;
};

export interface RoomStore {
    createRoom(room: RoomRecord): Promise<void>;
    getRoom(roomId: string): Promise<RoomRecord | null>;
    deleteRoom(roomId: string): Promise<void>;
    setInvite(roomId: string, invite: RoomInvite): Promise<void>;
    getInvite(roomId: string): Promise<RoomInvite | null>;
    /** Atomically decrements usesLeft; rejects when none are left. */
    consumeInviteUse(roomId: string): Promise<void>;
    /** Atomically adds a member, enforcing the capacity cap and uniqueness. */
    addMember(roomId: string, member: RoomMember, maxMembers: number): Promise<void>;
    getMember(roomId: string, clientId: string): Promise<RoomMember | null>;
    removeMember(roomId: string, clientId: string): Promise<void>;
    listMembers(roomId: string): Promise<RoomMember[]>;
    addProposal(roomId: string, proposal: ProposalRecord): Promise<void>;
    getProposal(roomId: string, proposalId: string): Promise<ProposalRecord | null>;
    /** Atomically moves a pending proposal to a final status; rejects otherwise. */
    transitionProposal(roomId: string, proposalId: string, status: Exclude<ProposalStatus, 'pending'>): Promise<ProposalRecord>;
    listProposals(roomId: string): Promise<ProposalRecord[]>;
    /** Idempotency cache: the ack payload previously produced for this opId, if any. */
    getOpResult(roomId: string, opId: string): Promise<Record<string, unknown> | null>;
    putOpResult(roomId: string, opId: string, result: Record<string, unknown>): Promise<void>;
    /** Appends with the next seq for the room and returns the stored event. */
    appendEvent(roomId: string, event: Omit<StoredEvent, 'seq'>): Promise<StoredEvent>;
    listEventsAfter(roomId: string, afterSeq: number): Promise<StoredEvent[]>;
}

export class InMemoryRoomStore implements RoomStore {
    #rooms = new Map<string, RoomRecord>();
    #invites = new Map<string, RoomInvite>();
    #members = new Map<string, Map<string, RoomMember>>();
    #proposals = new Map<string, Map<string, ProposalRecord>>();
    #opResults = new Map<string, Map<string, Record<string, unknown>>>();
    #events = new Map<string, StoredEvent[]>();

    async createRoom(room: RoomRecord): Promise<void> {
        if (this.#rooms.has(room.roomId)) throw new Error(`Room '${room.roomId}' already exists.`);
        this.#rooms.set(room.roomId, { ...room });
        this.#members.set(room.roomId, new Map());
        this.#proposals.set(room.roomId, new Map());
        this.#opResults.set(room.roomId, new Map());
        this.#events.set(room.roomId, []);
    }

    async getRoom(roomId: string): Promise<RoomRecord | null> {
        const room = this.#rooms.get(roomId);
        return room ? { ...room } : null;
    }

    async deleteRoom(roomId: string): Promise<void> {
        this.#rooms.delete(roomId);
        this.#invites.delete(roomId);
        this.#members.delete(roomId);
        this.#proposals.delete(roomId);
        this.#opResults.delete(roomId);
        this.#events.delete(roomId);
    }

    async setInvite(roomId: string, invite: RoomInvite): Promise<void> {
        if (!this.#rooms.has(roomId)) throw new Error(`Room '${roomId}' does not exist.`);
        this.#invites.set(roomId, { ...invite });
    }

    async getInvite(roomId: string): Promise<RoomInvite | null> {
        const invite = this.#invites.get(roomId);
        return invite ? { ...invite } : null;
    }

    async consumeInviteUse(roomId: string): Promise<void> {
        const invite = this.#invites.get(roomId);
        if (!invite || invite.usesLeft < 1) throw new Error('Invite has no uses left.');
        invite.usesLeft -= 1;
    }

    async addMember(roomId: string, member: RoomMember, maxMembers: number): Promise<void> {
        const members = this.#members.get(roomId);
        if (!members) throw new Error(`Room '${roomId}' does not exist.`);
        if (members.has(member.clientId)) throw new Error('Client is already a member.');
        if (members.size >= maxMembers) throw new Error('Room is full.');
        members.set(member.clientId, { ...member });
    }

    async getMember(roomId: string, clientId: string): Promise<RoomMember | null> {
        const member = this.#members.get(roomId)?.get(clientId);
        return member ? { ...member } : null;
    }

    async removeMember(roomId: string, clientId: string): Promise<void> {
        this.#members.get(roomId)?.delete(clientId);
    }

    async listMembers(roomId: string): Promise<RoomMember[]> {
        const members = this.#members.get(roomId);
        if (!members) return [];
        return [...members.values()].map((member) => ({ ...member }));
    }

    async addProposal(roomId: string, proposal: ProposalRecord): Promise<void> {
        const proposals = this.#proposals.get(roomId);
        if (!proposals) throw new Error(`Room '${roomId}' does not exist.`);
        proposals.set(proposal.proposalId, { ...proposal });
    }

    async getProposal(roomId: string, proposalId: string): Promise<ProposalRecord | null> {
        const proposal = this.#proposals.get(roomId)?.get(proposalId);
        return proposal ? { ...proposal } : null;
    }

    async transitionProposal(roomId: string, proposalId: string, status: Exclude<ProposalStatus, 'pending'>): Promise<ProposalRecord> {
        const proposal = this.#proposals.get(roomId)?.get(proposalId);
        if (!proposal) throw new Error('Proposal not found.');
        if (proposal.status !== 'pending') throw new Error('Proposal is not pending.');
        proposal.status = status;
        proposal.updatedAt = Date.now();
        return { ...proposal };
    }

    async listProposals(roomId: string): Promise<ProposalRecord[]> {
        const proposals = this.#proposals.get(roomId);
        if (!proposals) return [];
        return [...proposals.values()].map((proposal) => ({ ...proposal }));
    }

    async getOpResult(roomId: string, opId: string): Promise<Record<string, unknown> | null> {
        return this.#opResults.get(roomId)?.get(opId) ?? null;
    }

    async putOpResult(roomId: string, opId: string, result: Record<string, unknown>): Promise<void> {
        const results = this.#opResults.get(roomId);
        if (!results) throw new Error(`Room '${roomId}' does not exist.`);
        results.set(opId, { ...result });
    }

    async appendEvent(roomId: string, event: Omit<StoredEvent, 'seq'>): Promise<StoredEvent> {
        const log = this.#events.get(roomId);
        if (!log) throw new Error(`Room '${roomId}' does not exist.`);
        const stored: StoredEvent = { ...event, seq: log.length + 1 };
        log.push(stored);
        return { ...stored };
    }

    async listEventsAfter(roomId: string, afterSeq: number): Promise<StoredEvent[]> {
        const log = this.#events.get(roomId) ?? [];
        return log.filter((event) => event.seq > afterSeq).map((event) => ({ ...event }));
    }
}
