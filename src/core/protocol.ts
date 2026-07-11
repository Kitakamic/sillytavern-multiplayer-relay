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
    PROPOSAL_SUBMIT: 'proposal.submit',
    PROPOSAL_WITHDRAW: 'proposal.withdraw',
    PROPOSAL_ACCEPT: 'proposal.accept',
    PROPOSAL_REJECT: 'proposal.reject',
    STORY_MESSAGE_PUBLISH: 'story.message.publish',
    SIDECHAT_MESSAGE_POST: 'sidechat.message.post',
    GENERATION_START: 'generation.start',
    GENERATION_PROGRESS: 'generation.progress',
    GENERATION_FINISH: 'generation.finish',
});

export type ClientCommand = {
    v: number;
    kind: 'cmd';
    type: string;
    requestId: string;
    opId: string;
    payload?: Record<string, unknown>;
};

export type RelayMessage = ClientCommand | {
    v: number;
    kind: 'ack' | 'error' | 'event';
    type: string;
    requestId?: string;
    eventId?: string;
    payload?: Record<string, unknown>;
};

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

export function createError(message: string, requestId?: string): RelayMessage {
    return { v: PROTOCOL_VERSION, kind: 'error', type: 'relay.error', requestId, eventId: randomUUID(), payload: { message } };
}

export function serialize(message: RelayMessage): string {
    return JSON.stringify(message);
}
