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
    /** Appends with the next seq for the room and returns the stored event. */
    appendEvent(roomId: string, event: Omit<StoredEvent, 'seq'>): Promise<StoredEvent>;
    listEventsAfter(roomId: string, afterSeq: number): Promise<StoredEvent[]>;
}

export class InMemoryRoomStore implements RoomStore {
    #rooms = new Map<string, RoomRecord>();
    #events = new Map<string, StoredEvent[]>();

    async createRoom(room: RoomRecord): Promise<void> {
        if (this.#rooms.has(room.roomId)) throw new Error(`Room '${room.roomId}' already exists.`);
        this.#rooms.set(room.roomId, { ...room });
        this.#events.set(room.roomId, []);
    }

    async getRoom(roomId: string): Promise<RoomRecord | null> {
        const room = this.#rooms.get(roomId);
        return room ? { ...room } : null;
    }

    async deleteRoom(roomId: string): Promise<void> {
        this.#rooms.delete(roomId);
        this.#events.delete(roomId);
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
