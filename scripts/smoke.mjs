// Smoke test shared by both shells: /health, WS relay.ping ack, unknown-command rejection.
// Usage: node scripts/smoke.mjs [baseUrl]   (default http://127.0.0.1:3001)
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const base = (process.argv[2] ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

function fail(message) {
    console.error(`FAIL ${message}`);
    process.exit(1);
}

const health = await fetch(`${base}/health`).catch((error) => fail(`/health unreachable: ${error.message}`));
if (!health.ok) fail(`/health returned HTTP ${health.status}`);
const body = await health.json();
if (body.ok !== true) fail(`/health payload unexpected: ${JSON.stringify(body)}`);
console.log('PASS /health');

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
}).catch((error) => fail(`WebSocket connect failed: ${error.message}`));

const makeCommand = (type) => ({ v: 1, kind: 'cmd', type, requestId: randomUUID(), opId: randomUUID(), payload: {} });

function request(command, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('message', onMessage);
            reject(new Error(`timeout waiting for reply to ${command.type}`));
        }, timeoutMs);
        const onMessage = (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.requestId !== command.requestId) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message);
        };
        socket.on('message', onMessage);
        socket.send(JSON.stringify(command));
    });
}

const ack = await request(makeCommand('relay.ping')).catch((error) => fail(error.message));
if (ack.kind !== 'ack' || ack.type !== 'relay.ping.ack') fail(`unexpected ping reply: ${JSON.stringify(ack)}`);
console.log('PASS relay.ping ack');

const rejection = await request(makeCommand('no.such.command')).catch((error) => fail(error.message));
if (rejection.kind !== 'error') fail(`expected error for unknown command, got: ${JSON.stringify(rejection)}`);
console.log('PASS unknown command rejected');

socket.close();
console.log('SMOKE OK');
