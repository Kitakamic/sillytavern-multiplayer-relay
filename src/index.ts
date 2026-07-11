import http from 'node:http';
import process from 'node:process';
import { WebSocketServer } from 'ws';
import { parseClientCommand, createError, serialize } from './protocol.js';
import { RelaySession, RoomManager } from './room-manager.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3001);
const roomManager = new RoomManager();

const server = http.createServer((request, response) => {
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

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
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

server.listen(port, host, () => {
    console.log(`SillyTavern Multiplayer Relay listening on http://${host}:${port}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

