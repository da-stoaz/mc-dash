# Deploying MC Dash to a Linux host (Docker Compose)

This bundles the backend and frontend into two containers. The backend talks to
the host's Docker to run the actual Minecraft servers as sibling containers.

## 1. Get the code onto the server

```bash
git clone <your-repo-url> mc-dash      # or scp/rsync the folder over
cd mc-dash
```

## 2. Find the host's LAN IP

```bash
hostname -I        # e.g. 192.168.1.50
```

You'll open the dashboard from another machine, so the frontend and backend must
be reachable at this IP — not `localhost`.

## 3. Configure

```bash
cp .env.example .env
nano .env
```

Set at minimum:
- `NEXT_PUBLIC_API_BASE_URL=http://<lan-ip>:4000`
- `MC_DASH_FRONTEND_ORIGIN=http://<lan-ip>:3000`
- `MC_DASH_PASSWORD=` something strong
- `MC_DASH_SESSION_SECRET=` `openssl rand -hex 32`
- `MC_DASH_DATA_DIR=/opt/mc-dash/data` (absolute path; keep as-is unless you have a reason)

## 4. Create the data directory

```bash
sudo mkdir -p /opt/mc-dash/data
sudo chown "$(id -u)":"$(id -g)" /opt/mc-dash/data   # optional; backend runs as root anyway
```

## 5. Launch

```bash
docker compose up -d --build
```

- Dashboard: `http://<lan-ip>:3000`
- API health check: `http://<lan-ip>:4000/health`

Update later with:

```bash
git pull && docker compose up -d --build
```

## Why it's wired this way

- **Docker socket mount** (`/var/run/docker.sock`): the backend uses the host's
  Docker engine to create the per-server containers — no docker-in-docker.
- **Identical data path** (`/opt/mc-dash/data` on host *and* in the container):
  the backend bind-mounts each server's folder into its Minecraft container.
  Docker resolves bind-mount source paths on the **host**, so the path the
  backend writes to must equal the host path. Mismatching this is the classic
  "server pack uploaded but the container starts empty" bug.
- **Host networking on the backend**: lets the optional handshake router reach
  servers on `127.0.0.1:<port>` and publishes server ports directly on the host.

## Troubleshooting

- **Dashboard loads but every action says "can't reach backend"**: the baked-in
  `NEXT_PUBLIC_API_BASE_URL` is wrong. It's set at *build* time — after changing
  `.env` you must rebuild: `docker compose up -d --build`.
- **Login seems to work then immediately logs out**: cookie was dropped. Ensure
  `MC_DASH_COOKIE_SECURE=false` when serving over plain HTTP, and that
  `MC_DASH_FRONTEND_ORIGIN` exactly matches the URL in your browser bar.
- **Server pack uploads but the Minecraft container won't start / is empty**:
  `MC_DASH_DATA_DIR` is not mounted to the same absolute path inside the
  backend container. Keep the `volumes:` entry as `${DIR}:${DIR}`.
- **Permission denied on the Docker socket**: the backend container runs as
  root, which can read the socket. If you changed it to a non-root user, add the
  host's `docker` group GID.
- **Snapshot fails with `EACCES: permission denied, open '.../world/level.dat'`**:
  the server's world files are owned by a different user than the one running
  MC Dash. Minecraft containers now run as the same user as the backend
  (`MC_CONTAINER_USER`, defaulting to the backend's own uid:gid), so *new*
  servers avoid this. For a server created before this fix, chown its files once
  while it's stopped, then start it again:

  ```bash
  sudo chown -R "$(id -u)":"$(id -g)" /opt/mc-dash/data   # or your MC_DASH_DATA_DIR
  ```

  Both steps matter: the chown fixes the files that already exist, and the next
  **Start** rebuilds that server's container so it runs as the MC Dash user from
  then on. Without the rebuild the still-root container would re-own the world on
  its next save and the error would come back — so a plain restart now performs
  that rebuild automatically when it detects the mismatch.

  If a pack needs to install packages at runtime (which requires root inside the
  container), set `MC_CONTAINER_USER=root` to keep that server running as root —
  but then run MC Dash as root too (e.g. the compose stack) so it can still read
  the files back for snapshots.
