import 'dotenv/config';
import process from 'node:process';
import { getRelayBuildInfo } from './build-info.js';
import { createRelayConfig } from './core/config.js';
import { InMemoryRoomStore } from './core/room-store.js';
import { InMemoryAssetStore } from './core/asset-store.js';
import { RoomManager } from './core/room-manager.js';
import { createRelayServer } from './core/server.js';

const creatorKey = process.env.RELAY_CREATOR_KEY ?? '';
if (!creatorKey || creatorKey === 'replace-with-a-long-random-secret') {
    console.error('[relay] RELAY_CREATOR_KEY must be set to a strong secret before starting the standalone shell.');
    process.exit(1);
}

const config = createRelayConfig({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3001),
    creatorKey,
    maxRoomMembers: process.env.MAX_ROOM_MEMBERS ? Number(process.env.MAX_ROOM_MEMBERS) : undefined,
    roomTtlHours: process.env.ROOM_TTL_HOURS ? Number(process.env.ROOM_TTL_HOURS) : undefined,
    inviteTtlHours: process.env.INVITE_TTL_HOURS ? Number(process.env.INVITE_TTL_HOURS) : undefined,
    assetTtlHours: process.env.ASSET_TTL_HOURS ? Number(process.env.ASSET_TTL_HOURS) : undefined,
});

const assetStore = new InMemoryAssetStore();
const buildInfo = getRelayBuildInfo();
const server = createRelayServer(config, new RoomManager(new InMemoryRoomStore(), assetStore, config), assetStore, buildInfo);
await server.listen();
console.log(`SillyTavern Multiplayer Relay ${buildInfo.version} (${buildInfo.commit}) listening on http://${config.host}:${config.port}`);

const shutdown = () => {
    void server.close().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
