import http from 'node:http';
import { WebSocketServer } from 'ws';
import { parseClientCommand, createError } from './protocol.js';
import { RelaySession, type RoomManager } from './room-manager.js';
import type { RelayConfig } from './config.js';

export type RelayServer = {
    httpServer: http.Server;
    listen(): Promise<void>;
    close(): Promise<void>;
};

/**
 * Builds the plain-HTTP/WS server for a shell to run. TLS is deliberately
 * absent — it terminates outside (Caddy on a VPS, the tunnel in local mode).
 */
export function createRelayServer(config: RelayConfig, roomManager: RoomManager): RelayServer {
    const httpServer = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        if (request.method === 'GET' && url.pathname === '/health') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ ok: true, service: 'sillytavern-multiplayer-relay' }));
            return;
        }

        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Not found' }));
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
                roomManager.handle(session, parseClientCommand(data.toString()));
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Invalid message.';
                session.send(createError(message));
            }
        });
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
