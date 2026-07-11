import WebSocket from 'ws';
import { createAck, createError, serialize, CommandType, type ClientCommand } from './protocol.js';
import type { RelayConfig } from './config.js';
import type { RoomStore } from './room-store.js';

export class RelaySession {
    constructor(public readonly socket: WebSocket) {}

    send(message: Parameters<typeof serialize>[0]): void {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(serialize(message));
        }
    }
}

/**
 * Transport-safe command boundary. Room commands, invitation issuance, and
 * role enforcement (milestones M1–M2) are implemented here against the
 * injected RoomStore, rather than being mixed into WebSocket handlers.
 */
export class RoomManager {
    constructor(
        private readonly store: RoomStore,
        private readonly config: RelayConfig,
    ) {}

    handle(session: RelaySession, command: ClientCommand): void {
        if (command.type === CommandType.RELAY_PING) {
            session.send(createAck(command, { serverTime: new Date().toISOString() }));
            return;
        }

        session.send(createError(`Command '${command.type}' is not implemented yet.`, command.requestId));
    }
}
