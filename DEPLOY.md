# Deploy MC Dash with Docker Compose

Production is **one folder with `docker-compose.yml` and `.env`**, like most
self-hosted apps. No Git checkout, Node.js or image builds on the server:

```sh
docker compose pull && docker compose up -d
```

GitHub Actions ([images.yml](.github/workflows/images.yml)) runs the backend tests, then tests and publishes
two images on every push to `main` and every `v*` tag:

| Image | Tags |
| --- | --- |
| `ghcr.io/da-stoaz/mc-dash-backend` | `latest` (main), `sha-<short>`, `1.2.3` / `1.2` (tags) |
| `ghcr.io/da-stoaz/mc-dash-frontend` | same |

`MC_DASH_VERSION` in `.env` selects the tag (default `latest`). Pin a `sha-…` or
version tag to hold a known-good build and to roll back.

The backend manages Minecraft containers through the host Docker socket. The
Compose project is named `mc-dash` regardless of the folder name.

## Requirements

- Linux host, Docker Engine, and Docker Compose v2.
- Rootful Docker using the systemd cgroup driver and cgroup v2, with
  [`minecraft.slice`](deploy/systemd/minecraft.slice) installed for the shared
  Minecraft RAM ceiling (see [memory-pool.md](docs/memory-pool.md#explicit-ubuntu-configuration)).
  Keep `MC_DASH_MEMORY_POOL=true`. The panel stays usable if verification fails,
  but Minecraft starts are blocked.
- Existing data stays on the host and is mounted at its **same absolute path**
  (`DATA_ROOT`). The bind mount refuses to create a missing directory, so a typo
  cannot silently start with empty data. Treat `DATA_ROOT` as fixed once servers
  exist: Minecraft containers bind-mount absolute paths below it and are reused on
  start, and uploaded packs are recorded by file path. It does not need to be next
  to `docker-compose.yml`.
- Host networking lets the Minecraft router reach published local ports. Both
  panel containers stay outside `minecraft.slice`.

## Install

```sh
mkdir -p ~/mc-dash && cd ~/mc-dash
base=https://raw.githubusercontent.com/da-stoaz/mc-dash/main
curl -fsSLO "$base/docker-compose.yml"
curl -fsSL "$base/.env.example" -o .env
chmod 600 .env
```

Edit `.env`: credentials, browser origin, absolute `DATA_ROOT`, and the Minecraft
process `MC_CONTAINER_USER` as numeric `uid:gid`. Create the data directory and
give that user access. Use single quotes around values containing `$` or `#`.
Never publish `.env` or output containing its values.

Install the RAM slice once (while no Minecraft server runs):

```sh
curl -fsSL "$base/deploy/systemd/minecraft.slice" -o /tmp/minecraft.slice
sudo install -m 0644 /tmp/minecraft.slice /etc/systemd/system/minecraft.slice
sudoedit /etc/systemd/system/minecraft.slice   # choose MemoryMax
sudo systemctl daemon-reload && sudo systemctl enable --now minecraft.slice
```

Then start:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 120
```

## Update

```sh
cd ~/mc-dash
docker compose pull && docker compose up -d
docker image prune -f   # drop superseded image layers
```

`.env` and host data are never touched by an update. `docker-compose.yml` rarely
changes; when a release notes that it did, fetch it again with the `curl` above
**before** pulling.

> **One-time step for the standalone frontend image:** images from this change on
> run Next's `server.js` directly and no longer contain `start.mjs`. A compose
> file that still runs `node start.mjs` must be replaced first (the new compose
> file also works with older images):
>
> ```sh
> cd ~/mc-dash
> curl -fsSLO https://raw.githubusercontent.com/da-stoaz/mc-dash/main/docker-compose.yml
> docker compose pull && docker compose up -d
> ```

Changing `.env` needs container recreation (`up -d`), not `restart`.

Back up the SQLite database (`DATA_ROOT`, including any `-wal`/`-shm` files)
before updates that change storage. Rolling back across such a change requires
the matching database backup. See [RAM settings and migration](docs/memory-pool.md).

### Roll back

Set `MC_DASH_VERSION=sha-<previous>` (or a version tag) in `.env`, then
`docker compose pull && docker compose up -d`. Never run two backends against the
same database. Do not restore old world backups over newer player progress
without explicitly choosing that recovery point.

## Configuration notes

- Root `.env` is the only production configuration. `backend/.env` and
  `frontend/.env.local` are for local development and never enter the images.
- The browser always calls `/api`; the frontend proxies it to the backend.
  `MC_DASH_BACKEND_PORT` sets the backend's loopback port, and the frontend's
  Next.js proxy ([`frontend/src/proxy.ts`](frontend/src/proxy.ts)) reads the
  resulting `MC_DASH_BACKEND_URL` at runtime, so the same published image works
  with any port. Only `MC_DASH_BACKEND_URL` and the port
  settings enter the frontend container; backend secrets do not.
- The backend assigns managed working files to `MC_CONTAINER_USER` after pack
  preparation/restoration and before Minecraft starts. Root-owned leftovers are
  repaired on the next stopped start. Linked or special files fail with an
  explicit error rather than being followed outside the server tree.

## Snapshot drive (optional)

By default, snapshots are stored in each server's folder under `DATA_ROOT`. To
keep them on a separate drive, such as an NFS share on a NAS, mount the drive on
the host and point `SNAPSHOT_ROOT` at it. Archives are then written to
`SNAPSHOT_ROOT/<server id>/`. Snapshots taken before the change stay where they
are and can still be downloaded and restored.

1. Mount the share on the host. Find its export path with `showmount -e`:

   ```sh
   sudo apt install nfs-common
   showmount -e <nas-ip>
   sudo mkdir -p /mnt/mc-dash-snapshots
   echo '<nas-ip>:<export-path> /mnt/mc-dash-snapshots nfs defaults,_netdev,nofail 0 0' | sudo tee -a /etc/fstab
   sudo mount /mnt/mc-dash-snapshots
   ```

2. Create the marker file. This also checks that root can write to the share,
   because the backend runs as root:

   ```sh
   sudo touch /mnt/mc-dash-snapshots/.mc-dash-snapshots
   ```

   Snapshots fail with "The snapshot drive is not available" when the marker is
   missing. This stops MC Dash from writing archives to the empty local folder
   of a share that is not mounted.

3. Next to `docker-compose.yml`, create `docker-compose.override.yml`. Compose
   reads it automatically:

   ```yaml
   services:
     backend:
       environment:
         SNAPSHOT_ROOT: /mnt/mc-dash-snapshots
       volumes:
         - type: bind
           source: /mnt/mc-dash-snapshots
           target: /mnt/mc-dash-snapshots
           bind:
             create_host_path: false
   ```

   Then run `docker compose up -d`. If the share is mounted after the backend
   has started, run `docker compose restart backend`, because the container
   only sees mounts that were present when it started.

Automatic backups are configured per server on its Snapshots tab.

## Build from source instead

From a checkout, the build override builds both images locally instead of pulling:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build --wait
```

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

CI runs exactly these before publishing images:

```sh
npm run test:deployment
npm --prefix frontend run test:config
docker build -t mc-dash-backend:deployment-check backend
docker build -t mc-dash-frontend:deployment-check frontend
npm run test:deployment:runtime
npm run test:deployment:host   # Linux only
```

The runtime check requires Compose 2.24.4+ and starts disposable containers with
temporary data and no Docker socket. It checks UI delivery, the real `/api` proxy,
login with a special-character password, session cookies, database access, live
updates streaming through the proxy, an intact 64 MiB upload chunk, that every
page and every built or public file is served, and that both panel containers
shut down on SIGTERM instead of being killed (the backend with a live-update
stream open). Next's proxy body limit accommodates the backend's
maximum supported chunk size (90 MiB plus 1 MiB slack).
The frontend image is built for the default backend port while the test runs the
backend on 3301, which proves the runtime proxy target works.
It uses a shared container network namespace for Docker Desktop compatibility.
The host check runs the shipped `docker-compose.yml` with Linux host networking
and verifies both panel ports answer on loopback only. Neither validates the
Minecraft memory slice.

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
