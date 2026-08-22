# MC Dash

TypeScript/Express backend and Next.js frontend for managing Minecraft servers from uploaded server packs running in Docker.

## Features (current)
- Persist server definitions (server pack file, RAM/CPU caps, render distance, game mode, seed) in SQLite.
- Endpoints for listing servers, creating entries, uploading packs, and issuing start/stop/restart/logs against Docker containers.
- Basic dashboard to list servers, view statuses, and manage uploads.
- Live per-server CPU and RAM on the server list, plus host totals — what servers are actually using, not just what they're allowed to use.
- Memory management: idle servers hand heap back to the OS, containers can't touch swap, and a start is refused when the host has no budget left (see below).
- Server console: run Minecraft commands (`/give`, `/tp`, `/kill`, …) against a live server over RCON, with completion for what the server actually has and failures shown as failures (see below).

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
- `GET /config` — browser-facing settings from the backend env (`routerEnabled`, `routerDomain`, `routerPort`). The dashboard reads this to render full hostnames.
- `GET /host/capacity` — the host memory ledger: total, reserve, budget, both admission tiers (guaranteed floors and expected peaks), and per-server figures including measured 7-day peaks. Drives the dashboard's memory bar.
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

Docker's memory limit is a ceiling, not a booking. Three servers capped at 8 GB
each start happily on a 12 GB host and idle at 3-4 GB between them — then all
peak at once, the kernel starts swapping, and the box stops answering SSH. MC
Dash handles this on three levels:

**1. Idle servers shrink.** Every pack's JVM flags are rewritten on prepare so
the heap follows real demand: `-Xms` is set to the server's *min RAM* (a real
floor, not a second `-Xmx`), `-XX:+AlwaysPreTouch` is forced off, and G1's
periodic GC ([JEP 346](https://openjdk.org/jeps/346)) is enabled so a server with
nobody on it hands committed heap back to the OS. Aikar's flags ship
`-Xms == -Xmx` plus `AlwaysPreTouch` — which is exactly why an idle modpack
server sits on its full 8 GB — so those two are replaced while every other flag
the pack author chose is preserved. Needs Java 12+ for full effect; older JVMs
ignore what they don't recognise.

The periodic GC runs as a **concurrent** cycle (`-XX:+G1PeriodicGCInvokesConcurrent`),
which matters more than it sounds. The full-GC variant reclaims no more — both
end at `-Xms` — but on a 1.5 GB live set it is a 365 ms stop-the-world pause, and
it fires on a timer whenever ordinary GCs have been quiet. A lightly-played
server goes minutes between young GCs while someone is very much standing in it,
so that pause lands mid-session and drops seven ticks. The concurrent cycle costs
37–66 ms instead. Do not "optimise" this flag back.

**2. Containers can't drag the host into swap.** Each container gets a hard
`Memory` cap (max RAM **plus JVM overhead** — metaspace, code cache, thread
stacks and GC structures live outside `-Xmx` but inside the cgroup, so capping
at exactly `-Xmx` gets the server OOM-killed as its heap fills), a soft
`MemoryReservation` at its idle footprint so the kernel reclaims from the
squatters first, and `MemorySwap == Memory` so it cannot page at all. A server
that blows its limit is killed; the host stays responsive. Set
`MC_DASH_CONTAINER_SWAP=limit` or `host` if you'd rather it paged.

**3. Starts are refused before they hurt — but only when it's real.** Admission
is two-tier, the way a cluster scheduler is:

- The **guaranteed** tier is every running server's idle floor (min RAM + JVM
  overhead) and is *never* overcommitted. Whatever happens, each running server
  can always have that much. For a server whose max is 6 GB, that's ~1.9 GB.
- The **burst** tier is peak demand, and it *is* allowed to exceed physical RAM —
  by `MC_DASH_MEMORY_BURST_RATIO` (default 2.0). Booking every ceiling in full is
  what makes a ledger strict but stupid: a 12 GB host would admit exactly one
  6 GB server, even though three of them idle at 3 GB together and never peak at
  the same instant.

The burst tier is an explicit bet that servers don't all peak at once. What makes
it reasonable rather than reckless is what happens when you lose it: with
container swap off, the kernel kills the one container that overran *its own*
cap. One bad minute for one server, not a frozen host. Set the ratio to 1.0 for
strict worst-case admission.

Peak demand is also *measured*, not assumed. Max RAM is a number people pick once
from a forum post; MC Dash already keeps 7 days of per-server peak memory, so a
server that has never crossed 2.1 GB in a week of play is budgeted at ~2.8 GB
(observed + 30% margin) rather than its notional 6.9 GB. Guards keep that honest:
a full day of history is required before a measurement counts as evidence, and
the configured ceiling is always a hard clamp. Disable with
`MC_DASH_MEMORY_USE_OBSERVED_PEAKS=false`.

The dashboard shows both tiers — a solid bar for what's reserved, a fainter band
for peak demand, and an oversubscription chip when ceilings exceed the host — so
the limit and the risk are visible before you hit either. Override a single start
with `{"force": true}`.

All of it is tunable — see the "Memory management" block in `.env.example`. The
defaults suit a small host and most people set none of them.

### Hibernation (opt-in)

Levels 1-3 make servers share a host politely. Hibernation removes them from it
entirely: a server with nobody on it is stopped, releasing **all** of its memory
and CPU, and started again when a player connects. On a host where four servers
exist but one is being played on, this is the only thing that actually fixes the
arithmetic. Enable with `MC_DASH_HIBERNATE=true`.

- **Sleep is evidence-based.** Player counts come from RCON, never inferred from
  CPU or traffic — guessing would eventually stop a server with someone standing
  in it. A count MC Dash *cannot* read resets the idle clock rather than counting
  as empty, so a server it can't ask is never one it puts to sleep.
- **Shutdown is the graceful path**, the same `save-all` + RCON `stop` the stop
  button uses. A hibernation that corrupted a world would be indefensible.
- **Waking is handled.** While asleep, MC Dash holds the server's port itself. A
  server-list ping gets a real status response saying it is sleeping (rather than
  a red "can't connect" cross), and a join attempt starts the server and
  disconnects the player with a message telling them to reconnect. The subdomain
  router does the same for its own targets.

The first join after a sleep always costs one bounced connection. That is
deliberate: a modpack takes 30-90 seconds to boot and a Minecraft client gives up
long before that, so holding the connection open would produce a timeout and a
player who concludes the server is dead. Telling them plainly and letting them
reconnect is the only honest option — it is what
[lazymc](https://github.com/timvisee/lazymc) does too.

> Levels 1 and 2 are applied when a server's pack is prepared and its container
> built, so **existing servers need a Rebuild** to pick them up. Level 3 — the
> start gate and the memory bar — works immediately, but until a server is
> rebuilt it will still hold its full heap while idle.

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
