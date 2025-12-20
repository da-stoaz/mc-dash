# MC Dash

TypeScript/Express backend and Next.js frontend for managing Minecraft servers from CurseForge packs running in Docker.

## Features (current)
- Persist server definitions (modpack IDs, RAM/CPU caps, render distance, game mode, seed) in SQLite.
- Endpoints for listing servers, creating entries, and issuing start/stop/restart/logs against Docker containers.
- Basic dashboard to list servers, view statuses, and create new entries.

## Quick start
1. Install dependencies:
   - Backend: `cd backend && npm install`
   - Frontend: `cd frontend && npm install`
2. Configure environment:
   - Backend: copy `backend/.env.example` to `backend/.env` and set `CURSEFORGE_API_KEY` plus Docker connection (socket or `DOCKER_HOST`).
   - Frontend: copy `frontend/.env.local.example` to `frontend/.env.local` and point `NEXT_PUBLIC_API_BASE_URL` to the backend (default `http://localhost:4000`).
3. Run:
   - Backend: `cd backend && npm run dev`
   - Frontend: `cd frontend && npm run dev`

## Backend endpoints (initial pass)
- `GET /health`
- `GET /servers` — list server records.
- `POST /servers` — create a record; body includes `name`, `packId`, `packFileId`, `packVersion`, `serverPackUrl`, `resources`, `game`.
- `PATCH /servers/:id` — update resources/game/status.
- `POST /servers/:id/prepare` — resolve/download server pack, unzip/configure, and create a Docker container (supports `serverPackUrl` as an http(s) URL or a local file path; otherwise uses `CURSEFORGE_API_KEY` to resolve).
- `GET /servers/:id/status` — inspect Docker container status.
- `POST /servers/:id/{start|stop|restart}` — issues container actions (expects container already built/created).
- `GET /servers/:id/logs` — streams Docker logs.

## CurseForge notes
- Uses the CurseForge API (`https://api.curseforge.com`, `x-api-key` header) to enumerate files. Look for `isServerPack` or `serverPackFileId` to find server-ready zips.
- Server pack download helper is in `backend/src/services/curseforgeService.ts`; it expects a direct `downloadUrl`.
- You still need a build/prepare step to:
  1. Download the server pack (or resolve the linked server pack from the client file).
  2. Unzip into a per-server directory (e.g., `backend/data/servers/<id>`).
  3. Apply JVM flags (min/max RAM) and `server.properties` (render distance, game mode, seed).
  4. Create a Docker container that mounts that directory and runs the correct start script (Forge/Fabric/etc.).
  That build step is not automated yet—container actions will error until wired up.

## Docker rootless vs root
- Rootless Docker cannot bind ports <1024 and has stricter cgroup limits (swap limits often unavailable; CPU/memory enforcement depends on host kernel). Volume permissions can also differ.
- Rootful Docker allows full cgroup limits and privileged ports. If you rely on tight resource caps or privileged ports, prefer rootful or test rootless carefully.

## File map
- Backend API: `backend/src/index.ts`, routes in `backend/src/routes/servers.ts`.
- SQLite store: `backend/src/serverStore.ts`.
- CurseForge helpers: `backend/src/services/curseforgeService.ts`.
- Prepare/build pipeline: `backend/src/services/prepareService.ts`.
- Docker actions: `backend/src/services/dockerService.ts`.
- Frontend UI: `frontend/src/app/page.tsx`.

## Next steps
- Add richer health checks (RCON or ping) and reflect in status.
- Support per-server host ports and collision checks.
- Add auth and validation on mutating endpoints.
