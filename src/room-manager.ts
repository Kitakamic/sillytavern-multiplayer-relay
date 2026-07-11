import WebSocket from 'ws';
import { createAck, createError, serialize, type ClientCommand } from './protocol.js';

export class RelaySession {
    constructor(public readonly socket: WebSocket) {}

    send(message: Parameters<typeof serialize>[0]): void {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(serialize(message));
        }
    }
}

/**
 * Transport-safe command boundary. Persistent rooms and authorization are added
 * here in the next milestone, rather than being mixed into WebSocket handlers.
 */
export class RoomManager {
    handle(session: RelaySession, command: ClientCommand): void {
        if (command.type === 'relay.ping') {
            session.send(createAck(command, { serverTime: new Date().toISOString() }));
            return;
        }

        session.send(createError(`Command '${command.type}' is not implemented yet.`, command.requestId));
    }
}
