# SillyTavern Multiplayer Relay

Private WebSocket relay for the SillyTavern Multiplayer Plugin.

The service is deliberately separate from SillyTavern. It coordinates room membership, invitations, ordering, and reconnects for clients that each run their own local SillyTavern. It must never receive an API key or a local filesystem path. Character and world data are likewise never received, with one exception: a character card the host explicitly shares to a room, which is relayed temporarily and deleted on expiry (see `docs/V1-PLAN.md`, milestone M4.5).

## V1 design

- WSS-only in production; TLS terminates at Caddy or Nginx.
- The Relay owns room metadata and the sequence of shared story events.
- The host owns the complete local chat and is the only client that calls an AI model.
- Shared text is stored temporarily for reconnects; private prompt context remains local.

## Development

```bash
npm install
copy .env.example .env
npm run dev
```

The health endpoint is available at `http://127.0.0.1:3001/health` by default. The WebSocket endpoint is `/ws`.

## Production

Use Docker Compose with Caddy after setting `RELAY_DOMAIN` and a strong `RELAY_CREATOR_KEY` in `.env`:

```bash
docker compose up -d --build
```

Only Caddy should expose ports 80 and 443. The Relay container is intentionally private to the Docker network.

## Status

This repository contains the runnable transport and protocol scaffold. Development follows the milestone plan in `docs/V1-PLAN.md` (single core, two deployment shells: VPS standalone and local Windows host). The next milestone is M0: extracting `src/core/` and adding the local shell.

