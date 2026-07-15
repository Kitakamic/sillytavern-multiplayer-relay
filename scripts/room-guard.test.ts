import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { InMemoryAssetStore } from '../src/core/asset-store.js';
import { createRelayConfig } from '../src/core/config.js';
import { CommandType, EventType, type ClientCommand } from '../src/core/protocol.js';
import { RelaySession, RoomManager } from '../src/core/room-manager.js';
import { InMemoryRoomStore, type StoredEvent } from '../src/core/room-store.js';

class FakeSocket {
    readyState = WebSocket.OPEN;
    readonly frames: string[] = [];

    send(frame: string): void {
        this.frames.push(frame);
    }

    close(): void {
        this.readyState = WebSocket.CLOSED;
    }
}

let sequence = 0;

function command(type: string, payload: Record<string, unknown> = {}): ClientCommand {
    sequence += 1;
    return {
        v: 1,
        kind: 'cmd',
        type,
        requestId: `request-${sequence}`,
        opId: `op-${sequence}`,
        payload,
    };
}

function reply(socket: FakeSocket, requestId: string): Record<string, unknown> {
    const frame = socket.frames
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((message) => message.requestId === requestId);
    assert.ok(frame, `missing reply for ${requestId}`);
    return frame;
}

const config = createRelayConfig({
    host: '127.0.0.1',
    port: 3001,
    creatorKey: 'test-creator-key',
    roomTtlHours: 0.00001,
});
const manager = new RoomManager(new InMemoryRoomStore(), new InMemoryAssetStore(), config);
const socket = new FakeSocket();
const session = new RelaySession(socket as unknown as WebSocket);

const hello = command(CommandType.AUTH_HELLO, { displayName: '房主' });
await manager.handle(session, hello);
const helloReply = reply(socket, hello.requestId);
assert.equal(helloReply.kind, 'ack');

const create = command(CommandType.ROOM_CREATE, { creatorKey: 'test-creator-key' });
await manager.handle(session, create);
assert.equal(reply(socket, create.requestId).kind, 'ack');

await new Promise((resolve) => setTimeout(resolve, 100));
const publish = command(CommandType.STORY_MESSAGE_PUBLISH, {
    text: '过期后不应写入',
    authorName: '房主',
    role: 'user',
});
await manager.handle(session, publish);
const publishReply = reply(socket, publish.requestId);
assert.equal(publishReply.kind, 'error');
assert.equal((publishReply.payload as Record<string, unknown>).code, 'NOT_IN_ROOM');
console.log('PASS expired room rejects story writes and closes the membership');

class GateStore extends InMemoryRoomStore {
    #leftReachedResolve: (() => void) | null = null;
    #releaseLeftResolve: (() => void) | null = null;
    #blockNextMemberLeft = true;

    waitForMemberLeft(): Promise<void> {
        return new Promise((resolve) => { this.#leftReachedResolve = resolve; });
    }

    releaseMemberLeft(): void {
        this.#releaseLeftResolve?.();
        this.#releaseLeftResolve = null;
    }

    override async appendEvent(roomId: string, event: Omit<StoredEvent, 'seq'>): Promise<StoredEvent> {
        if (this.#blockNextMemberLeft && event.type === EventType.ROOM_MEMBER_LEFT) {
            this.#blockNextMemberLeft = false;
            this.#leftReachedResolve?.();
            await new Promise<void>((resolve) => { this.#releaseLeftResolve = resolve; });
        }
        return super.appendEvent(roomId, event);
    }
}

async function authenticate(manager: RoomManager, socket: FakeSocket, session: RelaySession, displayName: string) {
    const hello = command(CommandType.AUTH_HELLO, { displayName });
    await manager.handle(session, hello);
    const result = reply(socket, hello.requestId);
    assert.equal(result.kind, 'ack');
    return result.payload as Record<string, unknown>;
}

const raceStore = new GateStore();
const raceManager = new RoomManager(raceStore, new InMemoryAssetStore(), createRelayConfig({
    host: '127.0.0.1',
    port: 3002,
    creatorKey: 'race-creator-key',
}));
const hostSocket = new FakeSocket();
const guestSocket = new FakeSocket();
const hostSession = new RelaySession(hostSocket as unknown as WebSocket);
const guestSession = new RelaySession(guestSocket as unknown as WebSocket);
await authenticate(raceManager, hostSocket, hostSession, '房主');
const guestCredentials = await authenticate(raceManager, guestSocket, guestSession, '客人');

const raceCreate = command(CommandType.ROOM_CREATE, { creatorKey: 'race-creator-key' });
await raceManager.handle(hostSession, raceCreate);
const roomCreated = reply(hostSocket, raceCreate.requestId).payload as Record<string, unknown>;
const roomId = String(roomCreated.roomId);
const guestJoin = command(CommandType.ROOM_JOIN, { roomId, token: roomCreated.inviteToken });
await raceManager.handle(guestSession, guestJoin);
assert.equal(reply(guestSocket, guestJoin.requestId).kind, 'ack');

const kick = command(CommandType.ROOM_KICK, { clientId: guestCredentials.clientId });
const kickPromise = raceManager.handle(hostSession, kick);
await raceStore.waitForMemberLeft();

const postKickPublish = command(CommandType.STORY_MESSAGE_PUBLISH, {
    text: '我在被踢后发言',
    authorName: '客人',
    role: 'user',
});
const postKickPromise = raceManager.handle(guestSession, postKickPublish);
await new Promise((resolve) => setTimeout(resolve, 10));
raceStore.releaseMemberLeft();
await Promise.all([kickPromise, postKickPromise]);
const postKickReply = reply(guestSocket, postKickPublish.requestId);
assert.equal(postKickReply.kind, 'error');
assert.equal((postKickReply.payload as Record<string, unknown>).code, 'NOT_IN_ROOM');
console.log('PASS a kicked member cannot commit a story write already racing with room.kick');

// A Persona refresh carries both the member-name write and the online event.
// Hold room.kick between its left-event append and member removal, then prove
// auth.hello waits behind that room mutex rather than resurrecting the seat.
const helloKickStore = new GateStore();
const helloKickManager = new RoomManager(helloKickStore, new InMemoryAssetStore(), createRelayConfig({
    host: '127.0.0.1',
    port: 3003,
    creatorKey: 'hello-kick-creator-key',
}));
const helloKickHostSocket = new FakeSocket();
const helloKickGuestSocket = new FakeSocket();
const helloKickHostSession = new RelaySession(helloKickHostSocket as unknown as WebSocket);
const helloKickGuestSession = new RelaySession(helloKickGuestSocket as unknown as WebSocket);
await authenticate(helloKickManager, helloKickHostSocket, helloKickHostSession, '房主');
const helloKickGuestCredentials = await authenticate(helloKickManager, helloKickGuestSocket, helloKickGuestSession, '客人');
const helloKickCreate = command(CommandType.ROOM_CREATE, { creatorKey: 'hello-kick-creator-key' });
await helloKickManager.handle(helloKickHostSession, helloKickCreate);
const helloKickRoom = reply(helloKickHostSocket, helloKickCreate.requestId).payload as Record<string, unknown>;
const helloKickRoomId = String(helloKickRoom.roomId);
const helloKickJoin = command(CommandType.ROOM_JOIN, { roomId: helloKickRoomId, token: helloKickRoom.inviteToken });
await helloKickManager.handle(helloKickGuestSession, helloKickJoin);

const helloKick = command(CommandType.ROOM_KICK, { clientId: helloKickGuestCredentials.clientId });
const helloKickPromise = helloKickManager.handle(helloKickHostSession, helloKick);
await helloKickStore.waitForMemberLeft();

const personaRefresh = command(CommandType.AUTH_HELLO, {
    displayName: '客人新 Persona',
    clientId: helloKickGuestCredentials.clientId,
    sessionToken: helloKickGuestCredentials.sessionToken,
});
const personaRefreshPromise = helloKickManager.handle(helloKickGuestSession, personaRefresh);
await Promise.resolve();
await Promise.resolve();
assert.equal(helloKickGuestSocket.frames.some((raw) => JSON.parse(raw).requestId === personaRefresh.requestId), false,
    'Persona hello must wait while room.kick owns the room');

helloKickStore.releaseMemberLeft();
await Promise.all([helloKickPromise, personaRefreshPromise]);
const personaRefreshReply = reply(helloKickGuestSocket, personaRefresh.requestId);
assert.equal(personaRefreshReply.kind, 'ack');
assert.equal((personaRefreshReply.payload as Record<string, unknown>).room, null,
    'a kicked identity resumes as room-less');
const helloKickEvents = helloKickHostSocket.frames
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.kind === 'event' && message.roomId === helloKickRoomId)
    .filter((message) => (message.payload as Record<string, unknown>).clientId === helloKickGuestCredentials.clientId);
const kickedIndex = helloKickEvents.findIndex((message) => message.type === EventType.ROOM_MEMBER_LEFT);
assert.notEqual(kickedIndex, -1, 'host receives the kicked member event');
assert.equal(helloKickEvents.slice(kickedIndex + 1).some((message) => message.type === EventType.ROOM_MEMBER_ONLINE), false,
    'member.online never follows member.left for the same kick');
console.log('PASS Persona hello cannot resurrect a member while room.kick is committing');

// The HTTP server uses withAuthorizedAssetAccess after it finishes reading a
// request body. This direct guard verifies that the final asset-store action
// is held behind room.kick and is never run for the removed member.
const assetKickStore = new GateStore();
const assetKickManager = new RoomManager(assetKickStore, new InMemoryAssetStore(), createRelayConfig({
    host: '127.0.0.1',
    port: 3004,
    creatorKey: 'asset-kick-creator-key',
}));
const assetKickHostSocket = new FakeSocket();
const assetKickGuestSocket = new FakeSocket();
const assetKickHostSession = new RelaySession(assetKickHostSocket as unknown as WebSocket);
const assetKickGuestSession = new RelaySession(assetKickGuestSocket as unknown as WebSocket);
await authenticate(assetKickManager, assetKickHostSocket, assetKickHostSession, '房主');
const assetKickGuestCredentials = await authenticate(assetKickManager, assetKickGuestSocket, assetKickGuestSession, '客人');
const assetKickCreate = command(CommandType.ROOM_CREATE, { creatorKey: 'asset-kick-creator-key' });
await assetKickManager.handle(assetKickHostSession, assetKickCreate);
const assetKickRoom = reply(assetKickHostSocket, assetKickCreate.requestId).payload as Record<string, unknown>;
const assetKickRoomId = String(assetKickRoom.roomId);
const assetKickJoin = command(CommandType.ROOM_JOIN, { roomId: assetKickRoomId, token: assetKickRoom.inviteToken });
await assetKickManager.handle(assetKickGuestSession, assetKickJoin);

const assetKick = command(CommandType.ROOM_KICK, { clientId: assetKickGuestCredentials.clientId });
const assetKickPromise = assetKickManager.handle(assetKickHostSession, assetKick);
await assetKickStore.waitForMemberLeft();
let assetActionRan = false;
const assetAccessPromise = assetKickManager.withAuthorizedAssetAccess(
    String(assetKickGuestCredentials.clientId),
    String(assetKickGuestCredentials.sessionToken),
    assetKickRoomId,
    async () => {
        assetActionRan = true;
        return 'stored';
    },
);
await Promise.resolve();
assert.equal(assetActionRan, false, 'asset action waits for the room mutex');
assetKickStore.releaseMemberLeft();
await assetKickPromise;
const assetAccess = await assetAccessPromise;
assert.deepEqual(assetAccess, { authorized: false, error: 'forbidden' });
assert.equal(assetActionRan, false, 'kicked member never reaches the asset action');
console.log('PASS kicked member cannot commit an HTTP asset action already racing with room.kick');

// Socket close is another room mutation. Once the room has expired, it must
// lazily close under the same mutex instead of appending a stale offline event.
const disconnectManager = new RoomManager(new InMemoryRoomStore(), new InMemoryAssetStore(), createRelayConfig({
    host: '127.0.0.1',
    port: 3005,
    creatorKey: 'disconnect-expiry-creator-key',
    roomTtlHours: 0.00001,
}));
const disconnectHostSocket = new FakeSocket();
const disconnectGuestSocket = new FakeSocket();
const disconnectHostSession = new RelaySession(disconnectHostSocket as unknown as WebSocket);
const disconnectGuestSession = new RelaySession(disconnectGuestSocket as unknown as WebSocket);
await authenticate(disconnectManager, disconnectHostSocket, disconnectHostSession, '房主');
await authenticate(disconnectManager, disconnectGuestSocket, disconnectGuestSession, '客人');
const disconnectCreate = command(CommandType.ROOM_CREATE, { creatorKey: 'disconnect-expiry-creator-key' });
await disconnectManager.handle(disconnectHostSession, disconnectCreate);
const disconnectRoom = reply(disconnectHostSocket, disconnectCreate.requestId).payload as Record<string, unknown>;
const disconnectRoomId = String(disconnectRoom.roomId);
const disconnectJoin = command(CommandType.ROOM_JOIN, { roomId: disconnectRoomId, token: disconnectRoom.inviteToken });
await disconnectManager.handle(disconnectGuestSession, disconnectJoin);
await new Promise((resolve) => setTimeout(resolve, 100));
disconnectManager.handleDisconnect(disconnectHostSession);
for (let attempt = 0; attempt < 20; attempt += 1) {
    const closed = disconnectGuestSocket.frames
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .some((message) => message.kind === 'event' && message.type === EventType.ROOM_CLOSED && message.roomId === disconnectRoomId);
    if (closed) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
}
const disconnectEvents = disconnectGuestSocket.frames
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.kind === 'event' && message.roomId === disconnectRoomId);
assert.equal(disconnectEvents.some((message) => message.type === EventType.ROOM_CLOSED), true,
    'an expired room closes when its host disconnects');
assert.equal(disconnectEvents.some((message) => message.type === EventType.ROOM_MEMBER_OFFLINE), false,
    'an expired room never emits a stale offline event');
console.log('PASS disconnect rechecks room TTL before publishing member.offline');
