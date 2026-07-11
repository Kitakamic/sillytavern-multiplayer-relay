# SillyTavern Multiplayer Relay

Private WebSocket relay for the SillyTavern Multiplayer Plugin.

The service is deliberately separate from SillyTavern. It coordinates room membership, invitations, ordering, and reconnects for clients that each run their own local SillyTavern. It must never receive an API key or a local filesystem path. Character and world data are likewise never received, with one exception: a character card the host explicitly shares to a room, which is relayed temporarily and deleted on expiry (see `docs/V1-PLAN.md`, milestone M2.5).

## V1 design

- WSS-only in production; TLS terminates at Caddy or Nginx.
- The Relay owns room metadata and the sequence of shared story events.
- The host owns the complete local chat and is the only client that calls an AI model.
- Shared text is stored temporarily for reconnects; private prompt context remains local.

## Development

```bash
npm install
npm run dev
```

`npm run dev` runs the local shell: it listens on `127.0.0.1:3001` and generates its creator key into `data/local-relay-state.json` on first start — no `.env` needed. Windows hosts can simply double-click `start-relay.bat`. To develop against the standalone (VPS) shell instead, copy `.env.example` to `.env` and use `npm run dev:standalone`.

The health endpoint is available at `http://127.0.0.1:3001/health` by default. The WebSocket endpoint is `/ws`. Run `npm run smoke` against either shell to verify it.

## Production

Use Docker Compose with Caddy after setting `RELAY_DOMAIN` and a strong `RELAY_CREATOR_KEY` in `.env`:

```bash
docker compose up -d --build
```

Only Caddy should expose ports 80 and 443. The Relay container is intentionally private to the Docker network.

## Status

Milestones M0–M2.5 are complete. The repository is split into `src/core/` (protocol, room manager, room store and asset store interfaces, server construction — no environment access) and two thin shells, `src/standalone.ts` (VPS/Docker) and `src/local.ts` (Windows host, auto-generated creator key, `start-relay.bat`). Live functionality: rooms, invitations, host/guest roles, and presence broadcasting (M1); the shared story timeline, proposal queue with server-enforced state transitions, side chat, transient generation-status broadcasts, and reconnect catch-up via `room.resume` with per-room `opId` idempotency (M2); and the HTTP asset channel — session-credential-authed upload/download of character-card PNGs and avatars, 5 MB cap, magic-byte checks, rate limits, TTL cleanup, deleted with the room (M2.5). Both shells pass the 71-check `scripts/smoke.mjs` flow. Development follows `docs/V1-PLAN.md`; next up is the plugin side (M3 control center), then host bridging (M4) and hardening (M5).

