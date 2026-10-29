# Deploy MC Dash with Docker Compose

Production uses **Docker Compose and one root `.env`**. The backend and Next.js
frontend are containers. Minecraft containers are managed through the host Docker
socket. No panel systemd units or production-only source patches are required.

The root `package.json` is a development command runner. Backend and frontend have
separate npm packages and lockfiles. Next.js's tracing and Turbopack roots are
explicitly `frontend`; the parent lockfile does not select the app root.

## Configuration and requirements

- Linux host, Docker Engine, and Docker Compose v2 with `up --wait` support.
- Rootful Docker using the systemd cgroup driver and cgroup v2, with
  `minecraft.slice` installed for the shared Minecraft RAM ceiling.
- Root `.env`: the sole production configuration; copy `.env.example` for a fresh install.
- `backend/.env` and `frontend/.env.local`: local development only. Docker ignores
  these files when building images. They do not configure the Compose deployment.
- Existing data stays on the host and is mounted at its **same absolute path**.
- Host networking allows the existing Minecraft router to reach published local
  ports. Both panel containers remain outside `minecraft.slice`.
- Frontend listens on loopback by default for a host reverse proxy or tunnel.
  Set `MC_DASH_FRONTEND_BIND_HOST=0.0.0.0` for deliberate LAN access.

The browser calls `/api`. The tracked `frontend/next.config.ts` forwards these
requests to the backend. `MC_DASH_BACKEND_PORT` determines both the backend port
and frontend proxy target. Rebuild the frontend when changing it. Do not copy or
cherry-pick a host-specific `next.config.ts` onto production.

Only explicitly listed frontend settings enter its container/build. Backend
passwords and session secrets stay out of the frontend image. Dockerfiles use
`npm ci` and the committed lockfiles; host `node_modules` are not used.

## Fresh installation

From the checkout:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env`: set credentials, browser origin, absolute `DATA_ROOT`, and the
Minecraft process `MC_CONTAINER_USER` as `uid:gid`. Create the data directory and
give that user appropriate access. The bind mount refuses to create a missing
host directory, preventing a typo from silently starting with empty data.
Use single quotes around values containing `$` or `#` to preserve them literally
in Compose configuration. Do not publish `.env` or output containing its values.

Install and verify [the Minecraft RAM slice](docs/memory-pool.md#explicit-ubuntu-configuration)
before starting Minecraft. Keep `MC_DASH_MEMORY_POOL=true`. The panel remains
usable if verification fails, but Minecraft starts are blocked.

```sh
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 120
```

## Migrate an existing host-process deployment

Keep the Minecraft servers stopped throughout the cutover. Do not move data or
change its ownership as part of this migration.

1. **Record the actual running configuration.** Inspect the old panel units
   locally: service user, working directory, executable, ports, environment files,
   inline overrides, and reverse-proxy/tunnel target. Resolve relative `DATA_ROOT`
   and `SQLITE_PATH` against the backend's current working directory. Confirm the
   database and server directories exist there. Do not infer them from examples.
2. **Back up configuration and state.** Save the old units, environment files,
   deployed commit, and proxy configuration outside the checkout. Stop the old
   panel services before making a consistent backup of the database (including
   any SQLite WAL/SHM files) and server data. Keep the old services disabled only
   after a successful cutover; do not uninstall them yet.
3. **Create root `.env` from the example and transfer existing settings.** Preserve
   the password, session secret, router domain/port, Java selection, upload limits,
   and other backend overrides. Preserve the Minecraft uid:gid. Set `DATA_ROOT`
   to the existing absolute data directory and `SQLITE_PATH` to the existing
   database, inside that directory. If the database is outside it, stop here and
   explicitly add its required same-path bind mount before deploying.
4. **Preserve the network contract.** Set `MC_DASH_BACKEND_PORT` to the old API port
   (for example `3301`) and `MC_DASH_FRONTEND_PORT` to the old dashboard port. Keep
   the public browser origin and proxy/tunnel target unchanged. Set
   `MC_DASH_MEMORY_POOL=true`. Check the Docker cgroup driver and install/verify
   `minecraft.slice` using the RAM instructions linked above, while all
   Minecraft servers remain stopped. Preserve an existing slice's chosen limit.
5. **Build and start from the merged repository source.** Run the fresh-install
   Compose commands above. Do not run the host npm services at the same time:
   they would compete for the same ports and database.
6. **Check before starting Minecraft.** Both containers must be healthy. Through
   the existing dashboard URL, verify login, server list, snapshots, and data
   paths. The frontend healthcheck also exercises `/api/health` through the actual
   proxy. Verify the RAM pool is enforced and the panel is outside it. Rebuild
   stopped Minecraft containers into the pool using the RAM migration guide.
   Start one server, verify its slice membership, files/ownership and router
   connection, then check a clean save and stop before starting the others.
7. **Finish the cutover.** Disable the old panel services so they cannot return on
   reboot. Archive old per-app runtime environment files outside the checkout;
   keep root `.env` as the sole production source. Retain backups for rollback.

### Rollback

Stop the Compose panel containers with `docker compose down` (never delete data
or volumes). Restore the saved application version/configuration and matching
backend database backup if necessary, then start the old panel services. Never
run both backends against the same database. Do not restore old world backups
over newer player progress without explicitly choosing that recovery point.

## Updates after migration

The total-container-RAM update migrates stored limits while preserving existing
ceilings. Back up SQLite before upgrading; rolling back to the previous heap-based
version requires restoring the matching database backup. See
[RAM settings and migration](docs/memory-pool.md).

The backend now assigns managed working files to `MC_CONTAINER_USER` after pack
preparation/restoration and before Minecraft starts. Keep numeric `uid:gid` in
`.env`. Existing root-owned working files are repaired on the next stopped start;
no rebuild or archive re-extraction is required solely to fix ownership. Linked
or special files fail with an explicit error rather than being followed outside
the server tree. Snapshot archives retain backend ownership.

```sh
git pull --ff-only
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 120
```

Back up state before upgrades that change storage. Root `.env` and host data are
not replaced by a Git update. A failed build leaves the existing containers alone.
Changing runtime settings requires container recreation (`up -d`), not merely
`restart`. The browser API path is always `/api`; no per-host source edits are needed.

## Shared Minecraft RAM limit

The shared ceiling requires `minecraft.slice` and `MC_DASH_MEMORY_POOL=true`.
Both are part of this production upgrade. Follow
[the RAM migration instructions](docs/memory-pool.md) while Minecraft servers
are stopped. The slice groups only Minecraft workloads; the dashboard containers
remain outside it. Setting the flag to false explicitly disables enforcement and
is not a completed RAM-management deployment. Ubuntu/systemd and real-world
save/recovery validation remains outstanding; the local container tests do not
provide that evidence.

## Public access

Keep the API bound to loopback (enforced by Compose). Put the dashboard behind
an authenticated reverse proxy/tunnel. With a host proxy, keep the frontend on
loopback too; a containerized proxy needs intentional host-network routing.
Use the same public origin for the UI and API. Preserve existing `/api` routing
if the host proxy already provides it, or forward all requests to the frontend's
tracked proxy. Set `MC_DASH_FRONTEND_ORIGIN` to the browser's actual origin.

For plain HTTP LAN use, set the origin to the LAN URL, frontend bind to `0.0.0.0`,
and `MC_DASH_COOKIE_SECURE=false`. For HTTPS use `MC_DASH_COOKIE_SECURE=true`.

## Verify deployment changes locally

```sh
npm run test:deployment
npm --prefix frontend run test:config
docker build -t mc-dash-backend:deployment-check backend
docker build -t mc-dash-frontend:deployment-check --build-arg MC_DASH_BACKEND_URL=http://127.0.0.1:3301 frontend
npm run test:deployment:runtime
```

The runtime check requires Compose 2.24.4+ and starts disposable containers with
temporary data and no Docker socket. It checks UI delivery, the real `/api` proxy,
login with a special-character password, session cookies, database access, and
an intact 64 MiB upload chunk. Next's proxy body limit accommodates the backend's
maximum supported chunk size (90 MiB plus 1 MiB slack).
It uses a shared container network namespace for Docker Desktop compatibility;
it does not validate Linux host networking or the Minecraft memory slice.

## Rebuild safety and temporary storage

Rebuild extracts and validates a replacement pack separately, then copies existing
worlds into it before publishing. Existing saves take precedence over bundled
worlds, including custom level names, nested packs and separate dimensions. Copying
uses filesystem reflinks when supported; otherwise allow temporary disk space for
the replacement pack **and** saved worlds. Disk exhaustion leaves the old pack intact.

A process crash during publication can leave `servers/<id>/.pack-before-rebuild`.
Starts and recreations then refuse to proceed. With that Minecraft container and
the backend stopped, retain both directories, inspect the saved previous pack,
and restore it as `pack` before retrying. Do not delete the retained copy blindly.
An ordinary caught preparation failure restores the previous pack automatically;
a Docker recreation failure may still require retrying the rebuild.

The backend image includes Python 3 for secure descriptor-relative file operations.
This is an internal filesystem helper, not a host setup script. Configuration
writes replace complete files atomically and never follow Minecraft-controlled
parent symlinks. Local npm development also requires `python3` on PATH.

Long dashboard actions (including import, restore, rebuild and settings that
recreate a container) use backend jobs and short status polls. Their results are
retained for seven days; a backend restart marks unfinished jobs as interrupted
instead of replaying them. API clients can request this with `Prefer: respond-async`
and poll the returned `statusUrl`. Clients that omit that header retain synchronous
responses and must configure their own proxy timeouts for long operations.
