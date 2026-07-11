// Smoke test shared by both shells: /health, WS relay.ping ack, and the M1
// room lifecycle (create/invite/join/presence/kick/leave) with two clients.
// Usage: node scripts/smoke.mjs [baseUrl]   (default http://127.0.0.1:3001)
// Creator key: RELAY_CREATOR_KEY env, else read from data/local-relay-state.json.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

function fail(message) {
    console.error(`FAIL ${message}`);
    process.exit(1);
}

function assert(condition, label, detail = '') {
    if (!condition) fail(`${label}${detail ? `: ${detail}` : ''}`);
    console.log(`PASS ${label}`);
}

function loadCreatorKey() {
    if (process.env.RELAY_CREATOR_KEY) return process.env.RELAY_CREATOR_KEY;
    try {
        const parsed = JSON.parse(readFileSync(new URL('../data/local-relay-state.json', import.meta.url), 'utf8'));
        if (typeof parsed.creatorKey === 'string' && parsed.creatorKey) return parsed.creatorKey;
    } catch { /* fall through */ }
    fail('creator key unavailable: set RELAY_CREATOR_KEY or run the local shell once');
}

class SmokeClient {
    constructor(label) {
        this.label = label;
        this.events = [];
        this.rescans = new Set();
    }

    async connect() {
        this.socket = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            this.socket.once('open', resolve);
            this.socket.once('error', reject);
        }).catch((error) => fail(`${this.label} connect failed: ${error.message}`));
        this.socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.kind === 'event') {
                this.events.push(message);
                for (const rescan of [...this.rescans]) rescan();
            }
        });
        return this;
    }

    /** Sends a command and resolves with the matching ack/error frame. */
    request(type, payload = {}, timeoutMs = 5000) {
        const command = { v: 1, kind: 'cmd', type, requestId: randomUUID(), opId: randomUUID(), payload };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.socket.off('message', onMessage);
                reject(new Error(`${this.label}: timeout waiting for reply to ${type}`));
            }, timeoutMs);
            const onMessage = (raw) => {
                const message = JSON.parse(raw.toString());
                if (message.requestId !== command.requestId) return;
                clearTimeout(timer);
                this.socket.off('message', onMessage);
                resolve(message);
            };
            this.socket.on('message', onMessage);
            this.socket.send(JSON.stringify(command));
        });
    }

    /** Resolves with the first (possibly already received) event matching type + predicate. */
    waitEvent(type, predicate = () => true, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const scan = () => {
                const index = this.events.findIndex((event) => event.type === type && predicate(event));
                if (index === -1) return false;
                const [event] = this.events.splice(index, 1);
                clearTimeout(timer);
                this.rescans.delete(scan);
                resolve(event);
                return true;
            };
            const timer = setTimeout(() => {
                this.rescans.delete(scan);
                reject(new Error(`${this.label}: timeout waiting for event ${type}`));
            }, timeoutMs);
            this.rescans.add(scan);
            scan();
        });
    }

    close() {
        this.socket.close();
    }
}

// --- Transport checks (pre-M1 behavior kept intact) ---

const health = await fetch(`${base}/health`).catch((error) => fail(`/health unreachable: ${error.message}`));
if (!health.ok) fail(`/health returned HTTP ${health.status}`);
const body = await health.json();
assert(body.ok === true, '/health');

const probe = await new SmokeClient('probe').connect();
const ping = await probe.request('relay.ping');
assert(ping.kind === 'ack' && ping.type === 'relay.ping.ack', 'relay.ping ack');
const preHello = await probe.request('room.create', {});
assert(preHello.kind === 'error' && preHello.payload.code === 'NOT_AUTHENTICATED', 'command before auth.hello rejected');
probe.close();

// --- M1: rooms and invitations ---

const creatorKey = loadCreatorKey();

const host = await new SmokeClient('host').connect();
const hostHello = await host.request('auth.hello', { displayName: '房主' });
assert(hostHello.kind === 'ack' && hostHello.payload.clientId && hostHello.payload.sessionToken, 'auth.hello issues identity');

const unknown = await host.request('no.such.command');
assert(unknown.kind === 'error' && unknown.payload.code === 'UNKNOWN_COMMAND', 'unknown command rejected');

const badKey = await host.request('room.create', { creatorKey: 'wrong-key' });
assert(badKey.kind === 'error' && badKey.payload.code === 'CREATOR_KEY_INVALID', 'wrong creator key rejected');

const created = await host.request('room.create', { creatorKey });
assert(created.kind === 'ack' && created.payload.roomId && created.payload.inviteToken, 'room.create');
assert(created.payload.members.length === 1 && created.payload.members[0].role === 'host', 'creator seated as host');
const { roomId, inviteToken } = created.payload;

// The invite code itself is composed plugin-side; simulate the same base64url JSON here.
const inviteCode = Buffer.from(JSON.stringify({ v: 1, relayUrl: wsUrl, roomId, token: inviteToken }), 'utf8').toString('base64url');
const invite = JSON.parse(Buffer.from(inviteCode, 'base64url').toString('utf8'));
assert(invite.roomId === roomId && invite.token === inviteToken, 'invite code roundtrip');

const guest = await new SmokeClient('guest').connect();
const guestHello = await guest.request('auth.hello', { displayName: '客人' });
const guestId = guestHello.payload.clientId;
const guestSessionToken = guestHello.payload.sessionToken;

const badJoin = await guest.request('room.join', { roomId: invite.roomId, token: 'not-the-token' });
assert(badJoin.kind === 'error' && badJoin.payload.code === 'INVITE_INVALID', 'wrong invite token rejected');

const joined = await guest.request('room.join', { roomId: invite.roomId, token: invite.token });
assert(joined.kind === 'ack' && joined.payload.role === 'guest' && joined.payload.members.length === 2, 'room.join via invite');
assert(joined.payload.members.some((m) => m.role === 'host' && m.online === true), 'guest sees host online');
await host.waitEvent('room.member.joined', (e) => e.payload.member.clientId === guestId);
assert(true, 'host sees member.joined broadcast');

const forbidden = await guest.request('room.kick', { clientId: hostHello.payload.clientId });
assert(forbidden.kind === 'error' && forbidden.payload.code === 'FORBIDDEN', 'guest cannot kick (host-only command)');

// Presence: hard-drop the guest socket, then resume the identity on a new connection.
guest.socket.terminate();
await host.waitEvent('room.member.offline', (e) => e.payload.clientId === guestId);
assert(true, 'host sees member.offline after guest drop');

const guest2 = await new SmokeClient('guest2').connect();
const resumed = await guest2.request('auth.hello', { displayName: '客人', clientId: guestId, sessionToken: guestSessionToken });
assert(resumed.kind === 'ack' && resumed.payload.room?.roomId === roomId, 'auth.hello resumes room membership');
await host.waitEvent('room.member.online', (e) => e.payload.clientId === guestId);
assert(true, 'host sees member.online after guest resume');

const kick = await host.request('room.kick', { clientId: guestId });
assert(kick.kind === 'ack', 'host kick acked');
const kickEvent = await guest2.waitEvent('room.member.left', (e) => e.payload.clientId === guestId);
assert(kickEvent.payload.reason === 'kicked', 'kicked guest notified with reason');

const third = await new SmokeClient('third').connect();
await third.request('auth.hello', { displayName: '第三人' });
const thirdJoin = await third.request('room.join', { roomId: invite.roomId, token: invite.token });
assert(thirdJoin.kind === 'ack' && thirdJoin.payload.members.length === 2, 'invite still usable within its use limit');

const left = await host.request('room.leave');
assert(left.kind === 'ack', 'host room.leave acked');
const closedEvent = await third.waitEvent('room.closed');
assert(closedEvent.payload.reason === 'host_left', 'guests told room closed when host leaves');

const gone = await third.request('room.join', { roomId: invite.roomId, token: invite.token });
assert(gone.kind === 'error' && gone.payload.code === 'ROOM_NOT_FOUND', 'closed room cannot be rejoined');

host.close();
guest2.close();
third.close();
console.log('SMOKE OK');
