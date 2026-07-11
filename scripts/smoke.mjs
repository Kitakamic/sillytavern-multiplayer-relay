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
        /** roomId → highest seq observed there; feeds room.resume. */
        this.maxSeqByRoom = new Map();
    }

    maxSeqIn(roomId) {
        return this.maxSeqByRoom.get(roomId) ?? 0;
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
                if (typeof message.seq === 'number' && message.seq > this.maxSeqIn(message.roomId)) {
                    this.maxSeqByRoom.set(message.roomId, message.seq);
                }
                this.events.push(message);
                for (const rescan of [...this.rescans]) rescan();
            }
        });
        return this;
    }

    /** Sends a command and resolves with the matching ack/error frame. */
    request(type, payload = {}, { opId = randomUUID(), timeoutMs = 5000 } = {}) {
        const command = { v: 1, kind: 'cmd', type, requestId: randomUUID(), opId, payload };
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
const thirdHello = await third.request('auth.hello', { displayName: '第三人' });
const thirdId = thirdHello.payload.clientId;
const thirdSessionToken = thirdHello.payload.sessionToken;
const thirdJoin = await third.request('room.join', { roomId: invite.roomId, token: invite.token });
assert(thirdJoin.kind === 'ack' && thirdJoin.payload.members.length === 2, 'invite still usable within its use limit');

const left = await host.request('room.leave');
assert(left.kind === 'ack', 'host room.leave acked');
const closedEvent = await third.waitEvent('room.closed');
assert(closedEvent.payload.reason === 'host_left', 'guests told room closed when host leaves');

const gone = await third.request('room.join', { roomId: invite.roomId, token: invite.token });
assert(gone.kind === 'error' && gone.payload.code === 'ROOM_NOT_FOUND', 'closed room cannot be rejoined');

// --- M2: shared timeline, proposal queue, reconnect resume ---

const created2 = await host.request('room.create', { creatorKey });
const room2 = created2.payload.roomId;
const token2 = created2.payload.inviteToken;
await guest2.request('room.join', { roomId: room2, token: token2 });
const thirdJoin2 = await third.request('room.join', { roomId: room2, token: token2 });
assert(thirdJoin2.kind === 'ack' && thirdJoin2.payload.members.length === 3, 'fresh room for M2 with three members');

const hostSubmit = await host.request('proposal.submit', { text: '房主不该提案' });
assert(hostSubmit.kind === 'error' && hostSubmit.payload.code === 'FORBIDDEN', 'host cannot submit proposals');

const submitOpId = randomUUID();
const submitted = await guest2.request('proposal.submit', { text: '我推门而入。' }, { opId: submitOpId });
assert(submitted.kind === 'ack' && submitted.payload.proposalId, 'guest proposal.submit');
const pA = submitted.payload.proposalId;
await host.waitEvent('proposal.submitted', (e) => e.payload.proposal.proposalId === pA);
assert(true, 'host sees proposal.submitted broadcast');

const resubmitted = await guest2.request('proposal.submit', { text: '我推门而入。' }, { opId: submitOpId });
assert(resubmitted.kind === 'ack' && resubmitted.payload.proposalId === pA, 'opId retry replays same ack (idempotent)');

const submittedB = await third.request('proposal.submit', { text: '我躲到桌子底下。' });
const pB = submittedB.payload.proposalId;

const submittedC = await guest2.request('proposal.submit', { text: '（口误，撤回这条）' });
const pC = submittedC.payload.proposalId;
const withdrawn = await guest2.request('proposal.withdraw', { proposalId: pC });
assert(withdrawn.kind === 'ack', 'author withdraws own proposal');
await host.waitEvent('proposal.withdrawn', (e) => e.payload.proposalId === pC);
const acceptWithdrawn = await host.request('proposal.accept', { proposalId: pC });
assert(acceptWithdrawn.kind === 'error' && acceptWithdrawn.payload.code === 'PROPOSAL_NOT_PENDING', 'withdrawn proposal cannot be accepted');

const guestAccept = await third.request('proposal.accept', { proposalId: pA });
assert(guestAccept.kind === 'error' && guestAccept.payload.code === 'FORBIDDEN', 'guest cannot accept proposals');

const rejected = await host.request('proposal.reject', { proposalId: pB, reason: '和当前场景冲突' });
assert(rejected.kind === 'ack', 'host rejects a proposal');
const rejectedEvent = await third.waitEvent('proposal.rejected', (e) => e.payload.proposalId === pB);
assert(rejectedEvent.payload.reason === '和当前场景冲突', 'author sees rejection with reason');

const accepted = await host.request('proposal.accept', { proposalId: pA });
assert(accepted.kind === 'ack', 'host accepts a proposal');
await guest2.waitEvent('proposal.accepted', (e) => e.payload.proposalId === pA);
assert(true, 'author sees proposal.accepted broadcast');

const published = await host.request('story.message.publish', { text: '我推门而入。', authorName: '客人', role: 'user', proposalId: pA });
assert(published.kind === 'ack' && published.payload.messageId && published.payload.seq > 0, 'host publishes accepted action to timeline');
const storyEvent = await third.waitEvent('story.message.published', (e) => e.payload.message.proposalId === pA);
assert(storyEvent.payload.message.role === 'user', 'guests see the story message');

const guestPublish = await third.request('story.message.publish', { text: '越权发布', authorName: 'x', role: 'user' });
assert(guestPublish.kind === 'error' && guestPublish.payload.code === 'FORBIDDEN', 'guest cannot publish to timeline');

await third.request('sidechat.message.post', { text: '这段好玩哈哈' });
const sidechatEvent = await host.waitEvent('sidechat.message.posted');
assert(sidechatEvent.payload.message.text === '这段好玩哈哈', 'sidechat message broadcast');

const guestGen = await third.request('generation.start', {});
assert(guestGen.kind === 'error' && guestGen.payload.code === 'FORBIDDEN', 'guest cannot broadcast generation status');
await host.request('generation.start', {});
const genStarted = await third.waitEvent('generation.started');
assert(genStarted.seq === undefined, 'generation events are transient (no seq)');
await host.request('generation.finish', {});
const genFinished = await third.waitEvent('generation.finished');
assert(genFinished.payload.ok === true, 'generation.finished broadcast');

// Reconnect resume: drop a guest, publish while away, then catch up with no gap and no duplicate.
const savedSeq = third.maxSeqIn(room2);
third.socket.terminate();
await host.waitEvent('room.member.offline', (e) => e.payload.clientId === thirdId);
const awayPublish = await host.request('story.message.publish', { text: '（第三人离线时的剧情推进）', authorName: '角色', role: 'assistant' });
assert(awayPublish.kind === 'ack', 'timeline advances while a guest is offline');

const third2 = await new SmokeClient('third2').connect();
const resumedHello = await third2.request('auth.hello', { displayName: '第三人', clientId: thirdId, sessionToken: thirdSessionToken });
assert(resumedHello.payload.room?.roomId === room2 && resumedHello.payload.room.generating === false, 'hello reports room and generating flag');

const resume = await third2.request('room.resume', { lastAppliedSeq: savedSeq });
assert(resume.kind === 'ack' && resume.payload.events.length > 0, 'room.resume returns missed events');
const seqs = resume.payload.events.map((e) => e.seq);
const contiguous = seqs.every((seq, i) => seq === savedSeq + i + 1);
assert(contiguous && resume.payload.lastSeq === seqs[seqs.length - 1], 'resume delta is gap-free and duplicate-free');
assert(resume.payload.events.some((e) => e.type === 'story.message.published' && e.payload.message.text.includes('离线时的剧情推进')), 'missed story message recovered');

const fullReplay = await third2.request('room.resume', { lastAppliedSeq: 0 });
const submitEvents = fullReplay.payload.events.filter((e) => e.type === 'proposal.submitted' && e.payload.proposal.proposalId === pA);
assert(submitEvents.length === 1, 'opId dedup kept the retried submit out of the log');
const rejectedOnTimeline = fullReplay.payload.events.some((e) => e.type === 'story.message.published' && e.payload.message.proposalId === pB);
assert(!rejectedOnTimeline, 'rejected proposal never appears on the story timeline');

const badResume = await third2.request('room.resume', { lastAppliedSeq: -1 });
assert(badResume.kind === 'error' && badResume.payload.code === 'BAD_PAYLOAD', 'invalid lastAppliedSeq rejected');

// --- M2.5: asset channel (HTTP, room-credential auth) ---

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);
const credHeaders = (clientId, sessionToken) => ({ 'x-relay-client-id': clientId, 'x-relay-session-token': sessionToken });
const hostCreds = credHeaders(hostHello.payload.clientId, hostHello.payload.sessionToken);
const guestCreds = credHeaders(guestId, guestSessionToken);
const thirdCreds2 = credHeaders(thirdId, thirdSessionToken);

const upload = (creds, roomId, query, body, contentType) =>
    fetch(`${base}/rooms/${roomId}/assets?${query}`, { method: 'POST', headers: { ...creds, 'content-type': contentType }, body });

const cardUp = await upload(hostCreds, room2, 'kind=card', png, 'image/png');
assert(cardUp.status === 200, 'host uploads character card');
const cardAssetId = (await cardUp.json()).assetId;

const download = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`, { headers: thirdCreds2 });
assert(download.status === 200 && download.headers.get('content-type') === 'image/png', 'guest downloads card with room credentials');
assert(Buffer.from(await download.arrayBuffer()).equals(png), 'downloaded bytes match upload');

const noAuth = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`);
assert(noAuth.status === 401, 'download without credentials rejected');
const badAuth = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`, { headers: credHeaders(thirdId, 'wrong-token') });
assert(badAuth.status === 401, 'download with wrong session token rejected');

const outsider = await new SmokeClient('outsider').connect();
const outsiderHello = await outsider.request('auth.hello', { displayName: '路人' });
const crossRoom = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`, {
    headers: credHeaders(outsiderHello.payload.clientId, outsiderHello.payload.sessionToken),
});
assert(crossRoom.status === 403, 'non-member cannot access room assets');

const guestCard = await upload(guestCreds, room2, 'kind=card', png, 'image/png');
assert(guestCard.status === 403, 'guest cannot upload a character card');
const guestAvatar = await upload(guestCreds, room2, 'kind=avatar', jpeg, 'image/jpeg');
assert(guestAvatar.status === 200, 'guest uploads own avatar');

const badKind = await upload(hostCreds, room2, 'kind=worldbook', png, 'image/png');
assert(badKind.status === 400, 'non-card/avatar assets refused (boundary)');
const wrongType = await upload(hostCreds, room2, 'kind=card', jpeg, 'image/jpeg');
assert(wrongType.status === 415, 'card must be image/png');
const badMagic = await upload(hostCreds, room2, 'kind=card', Buffer.alloc(32, 9), 'image/png');
assert(badMagic.status === 415, 'mislabeled body rejected by magic bytes');
const oversize = await upload(hostCreds, room2, 'kind=avatar', Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]), 'image/png');
assert(oversize.status === 413, 'oversize upload rejected');

const shortLived = await upload(thirdCreds2, room2, 'kind=avatar&ttlSeconds=1', png, 'image/png');
assert(shortLived.status === 200, 'ttlSeconds override accepted');
const shortId = (await shortLived.json()).assetId;
await new Promise((resolve) => setTimeout(resolve, 1300));
const expiredAsset = await fetch(`${base}/rooms/${room2}/assets/${shortId}`, { headers: thirdCreds2 });
assert(expiredAsset.status === 404, 'expired asset no longer served');

let saw429 = false;
for (let i = 0; i < 12 && !saw429; i++) {
    const res = await upload(hostCreds, room2, 'kind=avatar', png, 'image/png');
    if (res.status === 429) saw429 = true;
}
assert(saw429, 'upload rate limit kicks in');

const leaveFinal = await host.request('room.leave');
assert(leaveFinal.kind === 'ack', 'host closes the M2 room');
const afterClose = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`, { headers: thirdCreds2 });
assert(afterClose.status === 403, 'assets die with the room');

outsider.close();
host.close();
guest2.close();
third2.close();
console.log('SMOKE OK');
