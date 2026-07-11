import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;

/**
 * Command vocabulary. Must stay verbatim-identical to the plugin's
 * src/protocol.js — the authoritative table lives in the plugin
 * repository's docs/V1-PLAN.md §2.
 */
export const CommandType = Object.freeze({
    RELAY_PING: 'relay.ping',
    AUTH_HELLO: 'auth.hello',
    ROOM_CREATE: 'room.create',
    ROOM_JOIN: 'room.join',
    ROOM_RESUME: 'room.resume',
    ROOM_LEAVE: 'room.leave',
    ROOM_KICK: 'room.kick',
    ROOM_CARD_UPDATE: 'room.card.update',
    ROOM_CARD_CLEAR: 'room.card.clear',
    ROOM_CHAT_UPDATE: 'room.chat.update',
    ROOM_CHAT_CLEAR: 'room.chat.clear',
    STORY_MESSAGE_PUBLISH: 'story.message.publish',
    SIDECHAT_MESSAGE_POST: 'sidechat.message.post',
    ROUND_READY: 'round.ready',
    GENERATION_START: 'generation.start',
    GENERATION_PROGRESS: 'generation.progress',
    GENERATION_FINISH: 'generation.finish',
});

/**
 * Event vocabulary (relay → clients). Mirrored in the plugin's
 * src/protocol.js; documented in the plugin repository's docs/V1-PLAN.md §2.
 * generation.* events are transient: broadcast without a seq, never logged.
 */
export const EventType = Object.freeze({
    ROOM_MEMBER_JOINED: 'room.member.joined',
    ROOM_MEMBER_LEFT: 'room.member.left',
    ROOM_MEMBER_ONLINE: 'room.member.online',
    ROOM_MEMBER_OFFLINE: 'room.member.offline',
    ROOM_CLOSED: 'room.closed',
    ROOM_CARD_UPDATED: 'room.card.updated',
    ROOM_CARD_CLEARED: 'room.card.cleared',
    ROOM_CHAT_UPDATED: 'room.chat.updated',
    ROOM_CHAT_CLEARED: 'room.chat.cleared',
    STORY_MESSAGE_PUBLISHED: 'story.message.published',
    SIDECHAT_MESSAGE_POSTED: 'sidechat.message.posted',
    ROUND_READY_CHANGED: 'round.ready.changed',
    GENERATION_STARTED: 'generation.started',
    GENERATION_PROGRESSED: 'generation.progressed',
    GENERATION_FINISHED: 'generation.finished',
});

/**
 * Machine-readable error codes carried in error payloads (payload.code).
 * UNAUTHORIZED, the ASSET_ entries, and RATE_LIMITED are used by the HTTP
 * asset channel (M2.5), which returns JSON errors of the shape { error, code }.
 */
export const ErrorCode = Object.freeze({
    BAD_PAYLOAD: 'BAD_PAYLOAD',
    NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
    ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
    NOT_IN_ROOM: 'NOT_IN_ROOM',
    CREATOR_KEY_INVALID: 'CREATOR_KEY_INVALID',
    ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
    ROOM_FULL: 'ROOM_FULL',
    INVITE_INVALID: 'INVITE_INVALID',
    FORBIDDEN: 'FORBIDDEN',
    TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
    UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
    INTERNAL: 'INTERNAL',
    UNAUTHORIZED: 'UNAUTHORIZED',
    ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
    ASSET_TOO_LARGE: 'ASSET_TOO_LARGE',
    UNSUPPORTED_ASSET_TYPE: 'UNSUPPORTED_ASSET_TYPE',
    RATE_LIMITED: 'RATE_LIMITED',
});

export type ClientCommand = {
    v: number;
    kind: 'cmd';
    type: string;
    requestId: string;
    opId: string;
    payload?: Record<string, unknown>;
};

export type RelayReply = {
    v: number;
    kind: 'ack' | 'error';
    type: string;
    requestId?: string;
    eventId?: string;
    payload?: Record<string, unknown>;
};

/**
 * Room events carry roomId/seq at the top level: the plugin's RoomStore
 * dedupes on message.seq directly. Transient events (generation.*) omit
 * seq — they are broadcast-only and never enter the room log.
 */
export type RelayEvent = {
    v: number;
    kind: 'event';
    type: string;
    eventId: string;
    roomId: string;
    seq?: number;
    payload: Record<string, unknown>;
};

export type RelayMessage = ClientCommand | RelayReply | RelayEvent;

export function parseClientCommand(raw: string): ClientCommand {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Message must be an object.');

    const command = value as Partial<ClientCommand>;
    if (command.v !== PROTOCOL_VERSION || command.kind !== 'cmd') throw new Error('Unsupported protocol envelope.');
    if (typeof command.type !== 'string' || !command.type) throw new Error('Command type is required.');
    if (typeof command.requestId !== 'string' || typeof command.opId !== 'string') throw new Error('requestId and opId are required.');
    if (command.payload !== undefined && (command.payload === null || typeof command.payload !== 'object' || Array.isArray(command.payload))) {
        throw new Error('payload must be an object.');
    }

    return command as ClientCommand;
}

export function createAck(command: ClientCommand, payload: Record<string, unknown> = {}): RelayMessage {
    return { v: PROTOCOL_VERSION, kind: 'ack', type: `${command.type}.ack`, requestId: command.requestId, payload };
}

export function createError(message: string, requestId?: string, code: string = ErrorCode.INTERNAL): RelayMessage {
    return { v: PROTOCOL_VERSION, kind: 'error', type: 'relay.error', requestId, eventId: randomUUID(), payload: { message, code } };
}

export function createEvent(type: string, roomId: string, seq: number, payload: Record<string, unknown>): RelayEvent {
    return { v: PROTOCOL_VERSION, kind: 'event', type, eventId: randomUUID(), roomId, seq, payload };
}

/** Broadcast-only event with no seq; never appended to the room log. */
export function createTransientEvent(type: string, roomId: string, payload: Record<string, unknown>): RelayEvent {
    return { v: PROTOCOL_VERSION, kind: 'event', type, eventId: randomUUID(), roomId, payload };
}

export function serialize(message: RelayMessage): string {
    return JSON.stringify(message);
}
