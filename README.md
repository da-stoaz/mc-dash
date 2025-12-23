# MC Dash

TypeScript/Express backend and Next.js frontend for managing Minecraft servers from uploaded server packs running in Docker.

## Features (current)
- Persist server definitions (server pack file, RAM/CPU caps, render distance, game mode, seed) in SQLite.
- Endpoints for listing servers, creating entries, uploading packs, and issuing start/stop/restart/logs against Docker containers.
- Basic dashboard to list servers, view statuses, and manage uploads.

## Quick start
1. Install dependencies:
   - Backend: `cd backend && npm install`
   - Frontend: `cd frontend && npm install`
2. Configure environment:
   - Backend: copy `backend/.env.example` to `backend/.env` and set Docker connection (socket or `DOCKER_HOST`).
     - Optionally set `MC_SERVER_PORT_MIN`/`MC_SERVER_PORT_MAX` for auto-assigning ports.
     - For wildcard subdomains, set `MC_ROUTER_ENABLED=true` and `MC_ROUTER_DOMAIN=mc.example.com` (see below).
   - Frontend: copy `frontend/.env.local.example` to `frontend/.env.local` and point `NEXT_PUBLIC_API_BASE_URL` to the backend (default `http://localhost:4000`).
3. Run:
   - Backend: `cd backend && npm run dev`
   - Frontend: `cd frontend && npm run dev`

## Backend endpoints (initial pass)
- `GET /health`
- `GET /servers` — list server records.
- `POST /servers` — create a record with a server pack zip (multipart form, fields include `name`, `subdomain` (optional), `serverPort` (optional), `minRamMb`, `maxRamMb`, `cpuLimit`, `renderDistance`, `gameMode`, `seed`, `javaImage`, and file field `file`).
- `PATCH /servers/:id` — update resources/game/status.
- `POST /servers/:id/prepare` — unzip/configure the uploaded server pack and create a Docker container.
- `GET /servers/:id/status` — inspect Docker container status.
- `POST /servers/:id/{start|stop|restart}` — issues container actions (expects container already built/created).
- `GET /servers/:id/logs` — streams Docker logs.

## Server pack workflow
- Create a server with the server pack zip attached.
- Run the prepare step to:
  1. Unzip into a per-server directory (e.g., `backend/data/servers/<id>`).
  2. Apply JVM flags (min/max RAM) and `server.properties` (render distance, game mode, seed).
3. Create a Docker container that mounts that directory and runs the correct start script (Forge/Fabric/etc.).

## Subdomain routing (wildcard DNS)
To avoid per-server DNS entries, you can route all `*.mc.example.com` hostnames to the same server and let mc-dash forward based on the hostname in the Minecraft handshake.

1. Cloudflare DNS:
   - Add an `A` record for `mc` pointing to your server IP.
   - Add a wildcard `A` record for `*.mc` pointing to the same IP.
   - Set both to **DNS only** (gray cloud).
2. Backend config:
   - `MC_ROUTER_ENABLED=true`
   - `MC_ROUTER_DOMAIN=mc.example.com`
   - `MC_ROUTER_PORT=25565`
   - Ensure your auto-assign port range excludes the router port (e.g., `MC_SERVER_PORT_MIN=25566`).
3. Each server gets a subdomain (auto-generated from name or user-provided).

## Docker rootless vs root
- Rootless Docker cannot bind ports <1024 and has stricter cgroup limits (swap limits often unavailable; CPU/memory enforcement depends on host kernel). Volume permissions can also differ.
- Rootful Docker allows full cgroup limits and privileged ports. If you rely on tight resource caps or privileged ports, prefer rootful or test rootless carefully.

## File map
- Backend API: `backend/src/index.ts`, routes in `backend/src/routes/servers.ts`.
- SQLite store: `backend/src/serverStore.ts`.
- Prepare/build pipeline: `backend/src/services/prepareService.ts`.
- Docker actions: `backend/src/services/dockerService.ts`.
- Frontend UI: `frontend/src/app/page.tsx`.

## Next steps
- Add richer health checks (RCON or ping) and reflect in status.
- Support per-server host ports and collision checks.
- Add auth and validation on mutating endpoints.
