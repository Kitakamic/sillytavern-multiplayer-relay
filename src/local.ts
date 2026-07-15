import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getRelayBuildInfo } from './build-info.js';
import { createRelayConfig } from './core/config.js';
import { InMemoryRoomStore } from './core/room-store.js';
import { InMemoryAssetStore } from './core/asset-store.js';
import { RoomManager } from './core/room-manager.js';
import { createRelayServer } from './core/server.js';

// dist/local.js and src/local.ts both sit one level below the repo root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, 'data');
const stateFile = path.join(dataDir, 'local-relay-state.json');

function loadOrCreateCreatorKey(): string {
    try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as { creatorKey?: unknown };
        if (typeof parsed.creatorKey === 'string' && parsed.creatorKey.length >= 32) {
            return parsed.creatorKey;
        }
        console.warn('[relay] data/local-relay-state.json 内容异常，将重新生成房主密钥。');
    } catch {
        // 首次运行，下面生成。
    }

    const creatorKey = randomBytes(32).toString('base64url');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ creatorKey }, null, 4) + '\n', 'utf8');
    return creatorKey;
}

const port = Number(process.env.RELAY_LOCAL_PORT ?? 3001);
const config = createRelayConfig({
    host: '127.0.0.1',
    port,
    creatorKey: loadOrCreateCreatorKey(),
});

const assetStore = new InMemoryAssetStore();
const buildInfo = getRelayBuildInfo();
const server = createRelayServer(config, new RoomManager(new InMemoryRoomStore(), assetStore, config), assetStore, buildInfo);
await server.listen();

console.log('[SillyTavern Multiplayer Relay] 本地模式已启动');
console.log(`  版本         ${buildInfo.version} (${buildInfo.commit})`);
console.log(`  健康检查   http://127.0.0.1:${port}/health`);
console.log(`  WebSocket  ws://127.0.0.1:${port}/ws`);
console.log(`  房主密钥   ${config.creatorKey}`);
console.log('             （已保存在 data/local-relay-state.json，建房时使用，不要发给客人）');
console.log('  公网接入   本机只监听 127.0.0.1；让朋友加入需要隧道，例如:');
console.log(`             cloudflared tunnel --url http://127.0.0.1:${port}`);

const shutdown = () => {
    void server.close().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
