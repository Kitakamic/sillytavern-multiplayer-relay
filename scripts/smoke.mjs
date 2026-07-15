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
assert(typeof body.version === 'string' && body.version.length > 0, '/health exposes version');
assert(typeof body.commit === 'string' && body.commit.length > 0, '/health exposes commit');
assert(health.headers.get('cache-control') === 'no-store', '/health is never cached');

const probe = await new SmokeClient('probe').connect();
const ping = await probe.request('relay.ping');
assert(ping.kind === 'ack' && ping.type === 'relay.ping.ack', 'relay.ping ack');
const preHello = await probe.request('room.create', {});
assert(preHello.kind === 'error' && preHello.payload.code === 'NOT_AUTHENTICATED', 'command before auth.hello rejected');
probe.close();

const boundA = await new SmokeClient('bound-a').connect();
const boundAHello = await boundA.request('auth.hello', { displayName: '身份 A' });
const boundB = await new SmokeClient('bound-b').connect();
const boundBHello = await boundB.request('auth.hello', { displayName: '身份 B' });
const identitySwitch = await boundA.request('auth.hello', {
    displayName: '冒充身份 B',
    clientId: boundBHello.payload.clientId,
    sessionToken: boundBHello.payload.sessionToken,
});
assert(identitySwitch.kind === 'error' && identitySwitch.payload.code === 'UNAUTHORIZED', 'authenticated socket cannot switch to another identity');
const boundAStillValid = await boundA.request('auth.hello', {
    displayName: '身份 A 更新',
    clientId: boundAHello.payload.clientId,
    sessionToken: boundAHello.payload.sessionToken,
});
assert(boundAStillValid.kind === 'ack' && boundAStillValid.payload.clientId === boundAHello.payload.clientId, 'rejected identity switch keeps the original binding');
boundA.close();
boundB.close();

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

const renamed = await guest.request('auth.hello', {
    displayName: '客人新 Persona',
    clientId: guestId,
    sessionToken: guestSessionToken,
});
assert(renamed.kind === 'ack' && renamed.payload.clientId === guestId && renamed.payload.room?.roomId === roomId, 'auth.hello keeps the member seat while changing Persona');
const renamedEvent = await host.waitEvent('room.member.online', (e) => e.payload.clientId === guestId);
assert(renamedEvent.payload.displayName === '客人新 Persona', 'Persona change is broadcast to online members');
const renamedSnapshot = await host.request('room.resume', { lastAppliedSeq: host.maxSeqIn(roomId) });
assert(renamedSnapshot.payload.members.some((member) => member.clientId === guestId && member.displayName === '客人新 Persona'), 'room snapshot persists the changed Persona name');

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

// --- M2: shared timeline (direct mode), ready signals, reconnect resume ---

const created2 = await host.request('room.create', { creatorKey });
const room2 = created2.payload.roomId;
const token2 = created2.payload.inviteToken;
await guest2.request('room.join', { roomId: room2, token: token2 });
const thirdJoin2 = await third.request('room.join', { roomId: room2, token: token2 });
assert(thirdJoin2.kind === 'ack' && thirdJoin2.payload.members.length === 3, 'fresh room for M2 with three members');

// 直连模式：成员直接向共享时间线发言，relay 的 seq 是全序仲裁。
const publishOpId = randomUUID();
const guestPub = await guest2.request('story.message.publish', { text: '我推门而入。', authorName: '小红', role: 'user' }, { opId: publishOpId });
assert(guestPub.kind === 'ack' && guestPub.payload.messageId && guestPub.payload.seq > 0, 'guest publishes a story message directly');
const guestPubEvent = await host.waitEvent('story.message.published', (e) => e.payload.message.messageId === guestPub.payload.messageId);
assert(guestPubEvent.payload.message.authorName === '小红' && guestPubEvent.payload.message.authorClientId === guestId, 'story message carries author identity');

const republished = await guest2.request('story.message.publish', { text: '我推门而入。', authorName: '小红', role: 'user' }, { opId: publishOpId });
assert(republished.kind === 'ack' && republished.payload.messageId === guestPub.payload.messageId, 'opId retry replays same ack (idempotent)');

const guestAssistant = await third.request('story.message.publish', { text: '越权的 AI 发言', authorName: 'AI', role: 'assistant' });
assert(guestAssistant.kind === 'error' && guestAssistant.payload.code === 'FORBIDDEN', 'guests cannot publish assistant messages');
const hostAssistant = await host.request('story.message.publish', { text: '门开了，风灌了进来。', authorName: '角色', role: 'assistant' });
assert(hostAssistant.kind === 'ack', 'host publishes the assistant reply');

const badRole = await guest2.request('story.message.publish', { text: 'x', authorName: 'y', role: 'system' });
assert(badRole.kind === 'error' && badRole.payload.code === 'BAD_PAYLOAD', 'invalid story role rejected');

const legacyProposal = await guest2.request('proposal.submit', { text: '旧协议命令' });
assert(legacyProposal.kind === 'error' && legacyProposal.payload.code === 'UNKNOWN_COMMAND', 'proposal commands removed from protocol');

// 共享文档编辑：任何成员可修改/删除任何故事消息（消息粒度 LWW，入日志可重放）。
const edited = await third.request('story.message.update', { messageId: guestPub.payload.messageId, text: '我推门而入。（修订）' });
assert(edited.kind === 'ack' && edited.payload.seq > 0, 'any member edits any story message');
const editEvent = await host.waitEvent('story.message.updated', (e) => e.payload.messageId === guestPub.payload.messageId);
assert(editEvent.payload.text === '我推门而入。（修订）' && editEvent.payload.editorClientId === thirdId, 'edit broadcast carries editor identity');
const emptyEdit = await third.request('story.message.update', { messageId: guestPub.payload.messageId, text: '   ' });
assert(emptyEdit.kind === 'error' && emptyEdit.payload.code === 'BAD_PAYLOAD', 'empty edit rejected');

const deleted = await guest2.request('story.message.delete', { messageId: guestPub.payload.messageId });
assert(deleted.kind === 'ack', 'any member deletes a story message');
const deleteEvent = await host.waitEvent('story.message.deleted', (e) => e.payload.messageId === guestPub.payload.messageId);
assert(deleteEvent.payload.removerClientId === guestId, 'delete broadcast carries remover identity');

// 生成请求（方案 a）：成员请求 → 瞬态广播给房主端执行；生成中拒绝。
const genReq = await third.request('generation.request', {});
assert(genReq.kind === 'ack', 'guest requests generation');
const reqEvent = await host.waitEvent('generation.requested', (e) => e.payload.clientId === thirdId);
assert(reqEvent.seq === undefined && reqEvent.payload.displayName === '第三人', 'generation request is transient with requester identity');
await host.request('generation.start', {});
await host.waitEvent('generation.started');
const busyReq = await guest2.request('generation.request', {});
assert(busyReq.kind === 'error' && busyReq.payload.code === 'RATE_LIMITED', 'generation request rejected while generating');
await host.request('generation.finish', {});
await host.waitEvent('generation.finished');

// 就绪/跳过信号：瞬态广播，不入日志。
const badReady = await guest2.request('round.ready', { state: 'done' });
assert(badReady.kind === 'error' && badReady.payload.code === 'BAD_PAYLOAD', 'invalid ready state rejected');
const readyAck = await guest2.request('round.ready', { state: 'ready' });
assert(readyAck.kind === 'ack', 'guest marks round ready');
const readyEvent = await host.waitEvent('round.ready.changed', (e) => e.payload.clientId === guestId);
assert(readyEvent.seq === undefined && readyEvent.payload.state === 'ready', 'ready signal is transient with state');
await third.request('round.ready', { state: 'skip' });
await host.waitEvent('round.ready.changed', (e) => e.payload.clientId === thirdId && e.payload.state === 'skip');
assert(true, 'skip signal broadcast');
await guest2.request('round.ready', { state: 'clear' });
await host.waitEvent('round.ready.changed', (e) => e.payload.clientId === guestId && e.payload.state === 'clear');
assert(true, 'clear signal broadcast');

await third.request('sidechat.message.post', { text: '这段好玩哈哈' });
const sidechatEvent = await host.waitEvent('sidechat.message.posted');
assert(sidechatEvent.payload.message.text === '这段好玩哈哈', 'sidechat message broadcast');

const guestGen = await third.request('generation.start', {});
assert(guestGen.kind === 'error' && guestGen.payload.code === 'FORBIDDEN', 'guest cannot broadcast generation status');
await host.request('generation.start', {});
const genStarted = await third.waitEvent('generation.started');
assert(genStarted.seq === undefined, 'generation events are transient (no seq)');
await host.request('generation.progress', { text: '门缓缓地打开了，走廊里' });
const genProgress = await third.waitEvent('generation.progressed', (e) => typeof e.payload.text === 'string');
assert(genProgress.payload.text === '门缓缓地打开了，走廊里', 'streaming text snapshot passes through');
const badProgress = await host.request('generation.progress', { text: 'x'.repeat(16001) });
assert(badProgress.kind === 'error' && badProgress.payload.code === 'BAD_PAYLOAD', 'oversized stream snapshot rejected');
await host.request('generation.finish', {});
const genFinished = await third.waitEvent('generation.finished');
assert(genFinished.payload.ok === true, 'generation.finished broadcast');

// 同连接命令串行化：发布与 generation.start 背靠背发出（不等 ack），广播顺序必须与发送顺序一致。
const raceText = '串行化检查——我推门而入';
const startedBefore = guest2.events.filter((e) => e.type === 'generation.started').length;
const racePublish = host.request('story.message.publish', { text: raceText, authorName: '房主', role: 'user' });
const raceStart = host.request('generation.start', {});
await Promise.all([racePublish, raceStart]);
{
    const deadline = Date.now() + 5000;
    let storyIdx = -1;
    let startedIdx = -1;
    while (Date.now() < deadline) {
        storyIdx = guest2.events.findIndex((e) => e.type === 'story.message.published' && e.payload.message.text === raceText);
        const startedNow = guest2.events.filter((e) => e.type === 'generation.started').length;
        if (storyIdx !== -1 && startedNow > startedBefore) {
            for (let i = guest2.events.length - 1; i >= 0; i--) {
                if (guest2.events[i].type === 'generation.started') { startedIdx = i; break; }
            }
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(storyIdx !== -1 && startedIdx !== -1 && storyIdx < startedIdx, 'per-connection serialization keeps broadcast order (publish before generation.started)');
}
await host.request('generation.finish', {});

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
const dupPublishes = fullReplay.payload.events.filter((e) => e.type === 'story.message.published' && e.payload.message.messageId === guestPub.payload.messageId);
assert(dupPublishes.length === 1, 'opId dedup kept the retried publish out of the log');
const readyLogged = fullReplay.payload.events.some((e) => e.type === 'round.ready.changed');
assert(!readyLogged, 'ready signals never enter the room log');

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

const preflight = await fetch(`${base}/rooms/${room2}/assets?kind=card`, {
    method: 'OPTIONS',
    headers: {
        origin: 'http://127.0.0.1:8000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-relay-client-id,x-relay-session-token',
    },
});
assert(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*', 'asset channel accepts browser CORS preflight');

const cardUp = await upload(hostCreds, room2, 'kind=card', png, 'image/png');
assert(cardUp.status === 200, 'host uploads character card');
const cardAssetId = (await cardUp.json()).assetId;

const guestCardPublish = await third2.request('room.card.update', { assetId: cardAssetId, characterName: '测试角色' });
assert(guestCardPublish.kind === 'error' && guestCardPublish.payload.code === 'FORBIDDEN', 'guest cannot publish shared card');

const cardPublished = await host.request('room.card.update', { assetId: cardAssetId, characterName: '测试角色', cardKey: 'ck-smoke-1', contentHash: 'a'.repeat(64) });
assert(cardPublished.kind === 'ack' && cardPublished.payload.assetId === cardAssetId, 'host publishes shared card');
const cardEvent = await third2.waitEvent('room.card.updated', (event) => event.payload.assetId === cardAssetId);
assert(cardEvent.payload.characterName === '测试角色', 'shared card broadcast reaches guest');
assert(cardEvent.payload.cardKey === 'ck-smoke-1' && cardEvent.payload.contentHash === 'a'.repeat(64), 'card dedup metadata passes through');

const cardReplay = await third2.request('room.resume', { lastAppliedSeq: cardEvent.seq - 1 });
assert(cardReplay.payload.events.some((event) => event.type === 'room.card.updated' && event.payload.assetId === cardAssetId), 'shared card survives resume replay');

const download = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`, { headers: thirdCreds2 });
assert(download.status === 200 && download.headers.get('content-type') === 'image/png', 'guest downloads card with room credentials');
assert(Buffer.from(await download.arrayBuffer()).equals(png), 'downloaded bytes match upload');

const cardCleared = await host.request('room.card.clear', { assetId: cardAssetId });
assert(cardCleared.kind === 'ack', 'host stops sharing card');
await third2.waitEvent('room.card.cleared', (event) => event.payload.assetId === cardAssetId);
const afterClear = await fetch(`${base}/rooms/${room2}/assets/${cardAssetId}`, { headers: thirdCreds2 });
assert(afterClear.status === 404, 'stopped card share is no longer downloadable');

// --- 联机存档（chat save, jsonl）走同一资产通道 ---

const saveLines = [
    { user_name: 'Host', character_name: '测试角色', chat_metadata: {} },
    { name: 'Host', is_user: true, mes: '第一句' },
    { name: '测试角色', is_user: false, mes: '第二句' },
];
const saveJsonl = Buffer.from(saveLines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');

const guestChatUp = await upload(guestCreds, room2, 'kind=chat', saveJsonl, 'application/jsonl');
assert(guestChatUp.status === 403, 'guest cannot upload a chat save');
const badJsonl = await upload(hostCreds, room2, 'kind=chat', Buffer.from('not json at all\n{}', 'utf8'), 'application/jsonl');
assert(badJsonl.status === 415, 'malformed jsonl rejected');
const chatUp = await upload(hostCreds, room2, 'kind=chat', saveJsonl, 'application/jsonl');
assert(chatUp.status === 200, 'host uploads chat save');
const chatAssetId = (await chatUp.json()).assetId;

const guestChatPublish = await third2.request('room.chat.update', { assetId: chatAssetId, chatName: '联机一局', messageCount: 2 });
assert(guestChatPublish.kind === 'error' && guestChatPublish.payload.code === 'FORBIDDEN', 'guest cannot publish chat save');
const badCount = await host.request('room.chat.update', { assetId: chatAssetId, chatName: '联机一局', messageCount: -1 });
assert(badCount.kind === 'error' && badCount.payload.code === 'BAD_PAYLOAD', 'negative messageCount rejected');

const chatPublished = await host.request('room.chat.update', {
    assetId: chatAssetId, chatName: '联机一局', messageCount: 2, saveKey: 'sk-smoke-1', contentHash: 'b'.repeat(64),
});
assert(chatPublished.kind === 'ack' && chatPublished.payload.assetId === chatAssetId, 'host publishes chat save');
const chatEvent = await third2.waitEvent('room.chat.updated', (event) => event.payload.assetId === chatAssetId);
assert(chatEvent.payload.chatName === '联机一局' && chatEvent.payload.messageCount === 2, 'chat save broadcast reaches guest');
assert(chatEvent.payload.saveKey === 'sk-smoke-1' && chatEvent.payload.contentHash === 'b'.repeat(64), 'save dedup metadata passes through');

const chatDownload = await fetch(`${base}/rooms/${room2}/assets/${chatAssetId}`, { headers: thirdCreds2 });
assert(chatDownload.status === 200, 'guest downloads chat save with room credentials');
assert(Buffer.from(await chatDownload.arrayBuffer()).equals(saveJsonl), 'downloaded save bytes match upload');

const chatReplay = await third2.request('room.resume', { lastAppliedSeq: 0 });
assert(chatReplay.payload.events.some((event) => event.type === 'room.chat.updated' && event.payload.assetId === chatAssetId), 'chat save survives resume replay');

const chatCleared = await host.request('room.chat.clear', { assetId: chatAssetId });
assert(chatCleared.kind === 'ack', 'host stops sharing chat save');
await third2.waitEvent('room.chat.cleared', (event) => event.payload.assetId === chatAssetId);
const chatAfterClear = await fetch(`${base}/rooms/${room2}/assets/${chatAssetId}`, { headers: thirdCreds2 });
assert(chatAfterClear.status === 404, 'stopped chat share is no longer downloadable');

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
