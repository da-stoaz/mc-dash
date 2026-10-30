# MC Dash

TypeScript/Express backend and Next.js frontend for managing Minecraft servers from uploaded server packs running in Docker.

Production uses **Docker Compose with one root `.env`**. See [DEPLOY.md](DEPLOY.md)
for setup and migration from host services. Per-app environment files below are
for local development only.

## Features (current)
- Persist server definitions (server pack file, RAM/CPU caps, render distance, game mode, seed) in SQLite.
- Endpoints for listing servers, creating entries, uploading packs, and issuing start/stop/restart/logs against Docker containers.
- Basic dashboard to list servers, view statuses, and manage uploads.
- Live per-server CPU and RAM on the server list, plus host totals — what servers are actually using, not just what they're allowed to use.
- Memory management: one configurable shared Linux RAM limit, elastic JVM heaps, and opt-in graceful sleep under RAM pressure (`MC_DASH_HIBERNATE=true`; see below).
- Server console: run Minecraft commands (`/give`, `/tp`, `/kill`, …) against a live server over RCON, with completion for what the server actually has and failures shown as failures (see below).

## Local development
Live Usage History includes TPS alongside CPU and memory, sampled every 5 seconds while viewed. It uses `spark tps`, with `forge tps` as a fallback, and displays the last 60 seconds. The backend retains up to 10 minutes in memory. RCON and a supported TPS command are required. The TPS chart is hidden for stopped servers or confirmed unsupported commands. Missing readings appear as gaps; sampling does not start a profiler or generate health reports.

Install Python 3 alongside Node.js for local backend development. Secure file
operations use its standard-library directory-descriptor APIs; no Python packages
are needed. The production backend image includes Python.

1. Install dependencies from the repository root: `npm run install:all`.
2. Configure environment:
   - Backend: copy `backend/.env.example` to `backend/.env` and set Docker connection (socket or `DOCKER_HOST`).
     - Optionally set `MC_SERVER_PORT_MIN`/`MC_SERVER_PORT_MAX` for auto-assigning ports.
     - For wildcard subdomains, set `MC_ROUTER_ENABLED=true` and `MC_ROUTER_DOMAIN=mc.example.com` (see below).
   - Frontend: copy `frontend/.env.local.example` to `frontend/.env.local`. The browser uses `/api`; the tracked Next.js configuration proxies to `MC_DASH_BACKEND_URL` (default `http://127.0.0.1:4000`).
3. Run `npm run dev` from the repository root to start both the backend and frontend. Logs are labelled by app; Ctrl+C stops both.
   - To run just one app: `npm run dev:backend` or `npm run dev:frontend`.

## Backend endpoints (initial pass)
- `GET /health`
- `GET /config` — browser-facing settings from the backend env (`routerEnabled`, `routerDomain`, `routerPort`). The dashboard reads this to render full hostnames.
- `GET /host/capacity` — verified shared-pool usage and protection status, plus legacy diagnostic accounting. Drives the RAM bar.
- `GET /servers` — list server records.
- `POST /servers` — create a record with a server pack zip (multipart form, fields include `name`, `subdomain` (optional), `serverPort` (optional), `minRamMb`, `maxRamMb`, `cpuLimit`, `renderDistance`, `gameMode`, `seed`, `javaImage`, and file field `file`).
- `PATCH /servers/:id` — update resources/game/status.
- `POST /servers/:id/prepare` — unzip/configure the uploaded server pack and create a Docker container.
- `GET /servers/:id/status` — inspect Docker container status.
- `POST /servers/:id/{start|stop|restart}` — issues container actions (expects container already built/created). `start` and `restart` are refused with 409 `MEMORY_GUARANTEE_EXCEEDED` / `MEMORY_BURST_EXCEEDED` / `HOST_MEMORY_LOW` when the host has no room; send `{"force": true}` to override.
- `GET /servers/:id/logs` — streams Docker logs.
- `POST /servers/:id/console` — run one Minecraft command on the live server over RCON. Body `{"command": "give Alice minecraft:diamond 64"}`; a leading `/` is accepted and stripped. Returns `{ id, command, output, at, status, suggestion? }`, where `status` is `ok`, `unknown-command`, or `bad-arguments`. Refused with 409 `CONSOLE_SERVER_NOT_RUNNING` / `CONSOLE_RCON_DISABLED` / `CONSOLE_RCON_NOT_READY` (connected but the server is still booting), 400 `CONSOLE_COMMAND_UNKNOWN` when this server has already said it has no such command, or 502 `CONSOLE_RCON_FAILED` when it doesn't answer.
- `GET /servers/:id/console` — recent console entries for this server; `DELETE` clears them.
- `GET /servers/:id/console/commands` — the commands to offer for completion: the standard catalog plus anything this server has shown it accepts, minus what it has said it doesn't have. Each carries `args` (label, options, wantsPlayer, optional) derived from its usage, which drives per-argument completion.

## Server pack workflow
- Create a server with the server pack zip attached.
- Run the prepare step to:
  1. Unzip into a per-server directory (e.g., `backend/data/servers/<id>`).
  2. Apply JVM flags (min/max RAM) and `server.properties` (render distance, game mode, seed).
3. Create a Docker container that mounts that directory and runs the correct start script (Forge/Fabric/etc.).

## Automatic mod dependencies

Prepare, Start, and Restart inspect modern Forge, NeoForge, and Fabric JAR metadata and install missing required server dependencies before launching Minecraft. This also repairs previously prepared servers on their next Start; no new ZIP upload is needed. Restart stops the container before modifying mods.

The resolver checks Minecraft version, loader, the actual mod ID/version inside each downloaded JAR, all requesting mods' version constraints, and dependencies of dependencies. It recognizes embedded libraries, Connector service wrappers (`connectormod`), and Fabric `provides` aliases, skips client-only and optional dependencies, and tries alternate versions if a candidate introduces a conflict. Connector also enables dependency checks for Fabric mods in Forge packs. Downloads use publisher checksums, HTTPS, bounded retries, and verified CDN redirects. New files are staged until the whole dependency set passes; a failed install rolls back additions and preserves existing mods. Installed filenames, checksums, and sources are recorded in the pack's `.mc-dash-dependencies.json` and backend logs. Complete packs need no network access.

Modrinth works without credentials. Set `CURSEFORGE_API_KEY` in the backend environment (or the root `.env` for Compose) to enable the [official CurseForge API](https://docs.curseforge.com/rest-api/). A pinned, checksum-verified fallback for [NightLib 1.3.0 on Forge 1.20.1](https://www.curseforge.com/minecraft/mc-mods/nightlib/files/8940234) works without a key, including resolving its Architectury dependency.

This cannot guarantee every modpack boots. Private or removed files, disabled third-party downloads, incomplete metadata, unsupported version expressions, and unrelated Java/mod conflicts can still need manual repair. The resolver does not replace an existing incompatible mod or change the pack's Minecraft/loader version; it returns a dependency error instead. Quilt and legacy `mcmod.info` dependency resolution are not supported. Startup scripts that download or replace mods after the preflight check remain responsible for those changes.

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

The dashboard reads `MC_ROUTER_DOMAIN` from the backend at runtime (`GET /config`), so it is configured in one place — no frontend rebuild needed to change the domain.

## Memory management

The pending shared-pool implementation isolates **Minecraft containers only**.
MC Dash's panel and backend remain outside the pool so a Minecraft-pool OOM does
not kill the controller needed to inspect and stop servers. Other deployments
also remain outside it; the host still needs enough memory for all of them.

The declarative [minecraft.slice](deploy/systemd/minecraft.slice) has a single
shared ceiling, `MemoryMax=12G`. MC Dash reads the installed Linux limit directly.
Individual Minecraft maximums are not reserved in full; unused capacity is shared.
There is no host-modifying setup script or service rewrite.

See [configuration, separation checks, and outstanding validation](docs/memory-pool.md).
Existing Minecraft containers need a stopped rebuild to join the new pool.
Failed verification blocks new Minecraft starts, while the panel remains usable.
Non-Linux development shows actual Minecraft memory usage in monitoring-only mode.

**Runtime enforcement has not been validated on the Ubuntu deployment.** Local
tests cover empty-server sleep, player warning countdowns, recovery cancellation,
and save failures. Automatic sleep requires `MC_DASH_HIBERNATE=true`; false also
disables pressure-triggered sleep. When enabled, occupied servers receive a 60-second
warning before saving and sleeping. Automatic sleep never falls back to a forced
Docker stop. Elastic JVM heaps also help release unused memory. Sudden growth or
failed saves can still cause Minecraft crashes at the kernel limit.

## Server console

The **Console** tab on a server's page runs Minecraft commands against the live
server and shows what the console printed back — `/give`, `/tp`, `/kill`,
`/gamemode`, `/time set day`, anything the server understands.

It talks to the server over RCON, which `prepare` turns on for every server
(`enable-rcon=true` with a random `rcon.password` in `server.properties`). The
RCON port is published on loopback only and never leaves the host, so the
console is reachable from MC Dash and nowhere else.

Notes:
- The prompt is live only while the server's status is **Running**. `Starting`
  is not good enough: Docker's port proxy accepts an RCON connection on the
  container's behalf long before Minecraft opens its own listener, so a command
  sent during boot connects, gets dropped, and fails for a reason that has
  nothing to do with the command. The status chip is the server's real status,
  never a claim about the connection.
- A hibernating server has to be started (or woken by a player) first; the
  console says so rather than failing silently.
- A leading `/` is optional — the console strips it, so commands can be pasted
  straight out of the chat box.
- ↑ / ↓ recall earlier commands. The scrollback is kept in memory on the
  backend so it survives a page reload, and resets when MC Dash restarts. It is
  a convenience, not an audit log.
- `stop` works, and is reported as a shutdown rather than an error — but the
  toolbar's Stop button is the better path, since it also releases the port and
  updates the server's state immediately.


### Only commands that work

Completion runs the whole way through a command, not just its name. At the
first token it lists commands by their full usage (`give <player> <item>
[count]`), so what a command takes is visible before it is picked. Past that,
each argument offers what it actually accepts: `gamemode` offers survival /
creative / adventure / spectator, `<player>` and `<target>` offer whoever is
online, and free-form slots like `<item>` offer nothing rather than guessing.
The usage sits above the prompt throughout with the argument being typed
picked out.

Those values come from the usage string itself — `parseUsageArgs` reads
`<a|b|c>` as an enumeration, a bare word as a literal, and `<player>` /
`<target>` as slots to fill from who is online — so each command is described
in exactly one place.

Beyond completion, the console leans on the server itself rather than on a
list we ship:

- Whatever the server answers normally is remembered as a command that works,
  which is how a modpack's own commands (`/ftbquests`, `/waystones`, …) end up
  in the completion list without MC Dash knowing anything about them.
- Whatever the server calls *unknown* is remembered too, and refused up front
  the next time, with the closest real command offered as a suggestion.
- A command that fails is shown as failed — red for one the server doesn't
  have, amber for a real command given bad arguments — so a typo never looks
  like it worked.

The vanilla catalog in `commandCatalog.ts` only seeds completion and the
"did you mean" suggestions. It is never used to refuse a command, because it
cannot know what a modpack added.

### RCON packet framing

Minecraft's RCON server does one `read()` per packet and drops the connection
unless the declared length matches that read exactly. So the client must never
have two requests in flight: writing a second packet before the first is
answered lets TCP coalesce them into one segment, and the server hangs up on
the pair. `rconClient.ts` sends one command at a time for that reason, and
`rconClient.test.ts` has a mock that reads the same strict way to keep it
honest. Responses over 4096 bytes arrive split across packets and are
reassembled; a short packet ends the response.
## Docker rootless vs root
- Rootless Docker cannot bind ports <1024 and has stricter cgroup limits (swap limits often unavailable; CPU/memory enforcement depends on host kernel). Volume permissions can also differ.
- Rootful Docker allows full cgroup limits and privileged ports. If you rely on tight resource caps or privileged ports, prefer rootful or test rootless carefully.
- Where swap limits are unavailable, MC Dash creates the container without them and logs a warning. The hard memory cap and the start gate still apply, but a server over its limit can be pushed into host swap.

## File map
- Backend API: `backend/src/index.ts`, routes in `backend/src/routes/servers.ts`.
- SQLite store: `backend/src/serverStore.ts`.
- Prepare/build pipeline: `backend/src/services/prepareService.ts`.
- Docker actions: `backend/src/services/dockerService.ts`.
- Memory management: `backend/src/services/jvmTuning.ts` (JVM flags), `memoryPlan.ts` (cgroup limits), `hostCapacityService.ts` (ledger + start gate).
- Server console: `backend/src/services/consoleService.ts` (validation, learned commands, RCON round-trip), `commandCatalog.ts` (completion catalog + output classification), `rconClient.ts` (protocol), `frontend/src/components/server-details/ConsoleCard.tsx` (UI).
- Frontend UI: `frontend/src/app/page.tsx`.

## Next steps
- Add richer health checks (RCON or ping) and reflect in status.
- Support per-server host ports and collision checks.
- Add auth and validation on mutating endpoints.
