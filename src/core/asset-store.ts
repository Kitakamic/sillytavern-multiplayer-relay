/**
 * Storage boundary for room assets (character card PNGs and avatar images),
 * the M2.5 asset channel. Sits beside RoomStore; the in-memory implementation
 * serves V1. This is deliberately NOT general file sharing: only the two
 * asset kinds exist, and everything dies with its room or its TTL.
 */
export type AssetKind = 'card' | 'avatar';

export type AssetRecord = {
    assetId: string;
    roomId: string;
    kind: AssetKind;
    contentType: string;
    bytes: number;
    uploaderClientId: string;
    createdAt: number;
    /** Absolute ms timestamp; the asset is unreachable afterwards. */
    expiresAt: number;
};

export interface AssetStore {
    putAsset(record: AssetRecord, data: Buffer): Promise<void>;
    getAsset(roomId: string, assetId: string): Promise<{ record: AssetRecord; data: Buffer } | null>;
    deleteAsset(roomId: string, assetId: string): Promise<void>;
    /** Room closed or expired: drop everything it owned. */
    deleteRoomAssets(roomId: string): Promise<void>;
    countRoomAssets(roomId: string): Promise<number>;
    /** Removes expired assets; returns how many were dropped. */
    sweepExpired(now: number): Promise<number>;
}

export class InMemoryAssetStore implements AssetStore {
    #assets = new Map<string, Map<string, { record: AssetRecord; data: Buffer }>>();

    async putAsset(record: AssetRecord, data: Buffer): Promise<void> {
        let room = this.#assets.get(record.roomId);
        if (!room) {
            room = new Map();
            this.#assets.set(record.roomId, room);
        }
        room.set(record.assetId, { record: { ...record }, data });
    }

    async getAsset(roomId: string, assetId: string): Promise<{ record: AssetRecord; data: Buffer } | null> {
        const entry = this.#assets.get(roomId)?.get(assetId);
        return entry ? { record: { ...entry.record }, data: entry.data } : null;
    }

    async deleteAsset(roomId: string, assetId: string): Promise<void> {
        this.#assets.get(roomId)?.delete(assetId);
    }

    async deleteRoomAssets(roomId: string): Promise<void> {
        this.#assets.delete(roomId);
    }

    async countRoomAssets(roomId: string): Promise<number> {
        return this.#assets.get(roomId)?.size ?? 0;
    }

    async sweepExpired(now: number): Promise<number> {
        let dropped = 0;
        for (const [roomId, room] of this.#assets) {
            for (const [assetId, entry] of room) {
                if (entry.record.expiresAt <= now) {
                    room.delete(assetId);
                    dropped += 1;
                }
            }
            if (room.size === 0) this.#assets.delete(roomId);
        }
        return dropped;
    }
}
