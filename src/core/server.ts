import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { parseClientCommand, createError, ErrorCode } from './protocol.js';
import { RelaySession, type RoomManager } from './room-manager.js';
import type { RelayConfig } from './config.js';
import type { AssetKind, AssetStore } from './asset-store.js';

export type RelayServer = {
    httpServer: http.Server;
    listen(): Promise<void>;
    close(): Promise<void>;
};

/**
 * Boundary declaration (M2.5): the asset channel is NOT general file sharing.
 * Only character-card PNGs and avatar images pass, capped at 5 MB — anything
 * else is refused regardless of configuration.
 */
const ASSET_MAX_BYTES = 5 * 1024 * 1024;
const ASSET_ROUTE = /^\/rooms\/([A-Za-z0-9_-]+)\/assets$/;
const ASSET_ITEM_ROUTE = /^\/rooms\/([A-Za-z0-9_-]+)\/assets\/([A-Za-z0-9-]+)$/;
const CLIENT_ID_HEADER = 'x-relay-client-id';
const SESSION_TOKEN_HEADER = 'x-relay-session-token';

const AVATAR_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Magic-byte check so a mislabeled body cannot smuggle another format. */
function matchesMagic(contentType: string, data: Buffer): boolean {
    switch (contentType) {
        case 'image/png':
            return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case 'image/jpeg':
            return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
        case 'image/webp':
            return data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
        default:
            return false;
    }
}

class FixedWindowLimiter {
    #hits = new Map<string, { count: number; windowStart: number }>();

    constructor(private readonly limit: number, private readonly windowMs: number) {}

    allow(key: string, now: number): boolean {
        const entry = this.#hits.get(key);
        if (!entry || now - entry.windowStart >= this.windowMs) {
            this.#hits.set(key, { count: 1, windowStart: now });
            return true;
        }
        entry.count += 1;
        return entry.count <= this.limit;
    }
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        request.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                request.destroy();
                reject(new Error('TOO_LARGE'));
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function sendJson(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

function sendError(response: http.ServerResponse, status: number, code: string, message: string): void {
    sendJson(response, status, { error: message, code });
}

/**
 * Builds the plain-HTTP/WS server for a shell to run. TLS is deliberately
 * absent — it terminates outside (Caddy on a VPS, the tunnel in local mode).
 */
export function createRelayServer(config: RelayConfig, roomManager: RoomManager, assetStore: AssetStore): RelayServer {
    // Upload rate limits (M2.5 按房间与连接限频): fixed one-minute windows.
    const uploadsPerClient = new FixedWindowLimiter(10, 60_000);
    const uploadsPerRoom = new FixedWindowLimiter(30, 60_000);
    const MAX_LIVE_ASSETS_PER_ROOM = 16;

    async function handleAssetUpload(request: http.IncomingMessage, response: http.ServerResponse, url: URL, roomId: string): Promise<void> {
        const clientId = request.headers[CLIENT_ID_HEADER];
        const sessionToken = request.headers[SESSION_TOKEN_HEADER];
        if (typeof clientId !== 'string' || typeof sessionToken !== 'string' || !clientId || !sessionToken) {
            sendError(response, 401, ErrorCode.UNAUTHORIZED, 'Missing session credentials.');
            return;
        }
        const access = await roomManager.authorizeAssetAccess(clientId, sessionToken, roomId);
        if (access === 'unauthorized') {
            sendError(response, 401, ErrorCode.UNAUTHORIZED, 'Bad session credentials.');
            return;
        }
        if (access === 'forbidden') {
            sendError(response, 403, ErrorCode.FORBIDDEN, 'Not a member of this room.');
            return;
        }

        const kind = url.searchParams.get('kind');
        if (kind !== 'card' && kind !== 'avatar') {
            sendError(response, 400, ErrorCode.BAD_PAYLOAD, "kind must be 'card' or 'avatar'.");
            return;
        }
        if (kind === 'card' && access.role !== 'host') {
            sendError(response, 403, ErrorCode.FORBIDDEN, 'Only the host may share a character card.');
            return;
        }

        const now = Date.now();
        if (!uploadsPerClient.allow(clientId, now) || !uploadsPerRoom.allow(roomId, now)) {
            sendError(response, 429, ErrorCode.RATE_LIMITED, 'Too many uploads; slow down.');
            return;
        }
        await assetStore.sweepExpired(now);
        if (await assetStore.countRoomAssets(roomId) >= MAX_LIVE_ASSETS_PER_ROOM) {
            sendError(response, 429, ErrorCode.RATE_LIMITED, 'Room asset quota reached.');
            return;
        }

        const contentType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const typeOk = kind === 'card' ? contentType === 'image/png' : AVATAR_CONTENT_TYPES.has(contentType);
        if (!typeOk) {
            sendError(response, 415, ErrorCode.UNSUPPORTED_ASSET_TYPE, kind === 'card'
                ? 'Character cards must be image/png.'
                : 'Avatars must be image/png, image/jpeg, or image/webp.');
            return;
        }

        const declaredLength = Number(request.headers['content-length'] ?? 0);
        if (declaredLength > ASSET_MAX_BYTES) {
            sendError(response, 413, ErrorCode.ASSET_TOO_LARGE, 'Assets are capped at 5 MB.');
            return;
        }

        let data: Buffer;
        try {
            data = await readBody(request, ASSET_MAX_BYTES);
        } catch (error) {
            if (error instanceof Error && error.message === 'TOO_LARGE') {
                sendError(response, 413, ErrorCode.ASSET_TOO_LARGE, 'Assets are capped at 5 MB.');
            } else {
                sendError(response, 400, ErrorCode.BAD_PAYLOAD, 'Upload aborted.');
            }
            return;
        }
        if (data.length === 0 || !matchesMagic(contentType, data)) {
            sendError(response, 415, ErrorCode.UNSUPPORTED_ASSET_TYPE, 'Body does not match the declared image type.');
            return;
        }

        const maxTtlSeconds = Math.floor(config.assetTtlHours * 3600);
        let ttlSeconds = maxTtlSeconds;
        const ttlParam = url.searchParams.get('ttlSeconds');
        if (ttlParam !== null) {
            ttlSeconds = Number(ttlParam);
            if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxTtlSeconds) {
                sendError(response, 400, ErrorCode.BAD_PAYLOAD, `ttlSeconds must be an integer between 1 and ${maxTtlSeconds}.`);
                return;
            }
        }

        const record = {
            assetId: randomUUID(),
            roomId,
            kind: kind as AssetKind,
            contentType,
            bytes: data.length,
            uploaderClientId: clientId,
            createdAt: now,
            expiresAt: Math.min(now + ttlSeconds * 1000, access.roomExpiresAt),
        };
        await assetStore.putAsset(record, data);
        sendJson(response, 200, { ok: true, assetId: record.assetId, kind: record.kind, bytes: record.bytes, expiresAt: record.expiresAt });
    }

    async function handleAssetDownload(request: http.IncomingMessage, response: http.ServerResponse, roomId: string, assetId: string): Promise<void> {
        const clientId = request.headers[CLIENT_ID_HEADER];
        const sessionToken = request.headers[SESSION_TOKEN_HEADER];
        if (typeof clientId !== 'string' || typeof sessionToken !== 'string' || !clientId || !sessionToken) {
            sendError(response, 401, ErrorCode.UNAUTHORIZED, 'Missing session credentials.');
            return;
        }
        const access = await roomManager.authorizeAssetAccess(clientId, sessionToken, roomId);
        if (access === 'unauthorized') {
            sendError(response, 401, ErrorCode.UNAUTHORIZED, 'Bad session credentials.');
            return;
        }
        if (access === 'forbidden') {
            sendError(response, 403, ErrorCode.FORBIDDEN, 'Not a member of this room.');
            return;
        }

        const asset = await assetStore.getAsset(roomId, assetId);
        if (!asset || asset.record.expiresAt <= Date.now()) {
            if (asset) await assetStore.deleteAsset(roomId, assetId);
            sendError(response, 404, ErrorCode.ASSET_NOT_FOUND, 'Asset not found or expired.');
            return;
        }

        response.writeHead(200, {
            'content-type': asset.record.contentType,
            'content-length': asset.record.bytes,
            'cache-control': 'private, no-store',
        });
        response.end(asset.data);
    }

    async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

        // Assets are fetched by the SillyTavern browser UI from a different
        // origin. Authentication stays in the explicit room headers; cookies
        // are never used, so a wildcard origin is safe and avoids deployment
        // specific origin configuration.
        response.setHeader('access-control-allow-origin', '*');
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', `content-type, ${CLIENT_ID_HEADER}, ${SESSION_TOKEN_HEADER}`);
        response.setHeader('access-control-max-age', '600');

        if (request.method === 'OPTIONS' && (ASSET_ROUTE.test(url.pathname) || ASSET_ITEM_ROUTE.test(url.pathname))) {
            response.writeHead(204);
            response.end();
            return;
        }

        if (request.method === 'GET' && url.pathname === '/health') {
            sendJson(response, 200, { ok: true, service: 'sillytavern-multiplayer-relay' });
            return;
        }

        const uploadMatch = url.pathname.match(ASSET_ROUTE);
        if (uploadMatch) {
            if (request.method !== 'POST') {
                sendError(response, 405, ErrorCode.BAD_PAYLOAD, 'Use POST to upload.');
                return;
            }
            await handleAssetUpload(request, response, url, uploadMatch[1]);
            return;
        }

        const itemMatch = url.pathname.match(ASSET_ITEM_ROUTE);
        if (itemMatch) {
            if (request.method !== 'GET') {
                sendError(response, 405, ErrorCode.BAD_PAYLOAD, 'Use GET to download.');
                return;
            }
            await handleAssetDownload(request, response, itemMatch[1], itemMatch[2]);
            return;
        }

        sendError(response, 404, ErrorCode.TARGET_NOT_FOUND, 'Not found');
    }

    const httpServer = http.createServer((request, response) => {
        void handleHttp(request, response).catch((error) => {
            console.error('[relay] http request failed:', error);
            if (!response.headersSent) sendError(response, 500, ErrorCode.INTERNAL, 'Internal relay error.');
            else response.destroy();
        });
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

    httpServer.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        if (url.pathname !== config.wsPath) {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (websocket) => {
            wss.emit('connection', websocket, request);
        });
    });

    wss.on('connection', (socket) => {
        const session = new RelaySession(socket);

        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                session.send(createError('Binary frames are not supported.'));
                return;
            }

            try {
                // handle() reports failures to the client itself and never rejects.
                void roomManager.handle(session, parseClientCommand(data.toString()));
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Invalid message.';
                session.send(createError(message));
            }
        });

        socket.on('close', () => roomManager.handleDisconnect(session));
    });

    return {
        httpServer,
        listen: () => new Promise<void>((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(config.port, config.host, () => {
                httpServer.removeListener('error', reject);
                resolve();
            });
        }),
        close: () => new Promise<void>((resolve, reject) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            httpServer.close((error) => (error ? reject(error) : resolve()));
        }),
    };
}
