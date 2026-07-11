/**
 * Relay configuration. Shells construct this from their own sources
 * (environment variables, generated local state) and inject it — core
 * never reads the environment or assumes TLS/process lifetime.
 */
export type RelayConfig = {
    /** Interface the HTTP/WS server binds to. */
    host: string;
    port: number;
    /** WebSocket endpoint path. */
    wsPath: string;
    /** Secret required to create rooms (enforced from M1). */
    creatorKey: string;
    maxRoomMembers: number;
    roomTtlHours: number;
};

export const CONFIG_DEFAULTS = Object.freeze({
    wsPath: '/ws',
    maxRoomMembers: 6,
    roomTtlHours: 168,
});

export type RelayConfigInput = {
    host: string;
    port: number;
    creatorKey: string;
    wsPath?: string;
    maxRoomMembers?: number;
    roomTtlHours?: number;
};

export function createRelayConfig(input: RelayConfigInput): RelayConfig {
    if (!input.host) throw new Error('host is required.');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
        throw new Error('port must be an integer between 1 and 65535.');
    }
    if (!input.creatorKey) throw new Error('creatorKey is required.');

    const maxRoomMembers = input.maxRoomMembers ?? CONFIG_DEFAULTS.maxRoomMembers;
    if (!Number.isInteger(maxRoomMembers) || maxRoomMembers < 2) {
        throw new Error('maxRoomMembers must be an integer of at least 2.');
    }

    const roomTtlHours = input.roomTtlHours ?? CONFIG_DEFAULTS.roomTtlHours;
    if (!Number.isFinite(roomTtlHours) || roomTtlHours <= 0) {
        throw new Error('roomTtlHours must be a positive number.');
    }

    return {
        host: input.host,
        port: input.port,
        wsPath: input.wsPath ?? CONFIG_DEFAULTS.wsPath,
        creatorKey: input.creatorKey,
        maxRoomMembers,
        roomTtlHours,
    };
}
