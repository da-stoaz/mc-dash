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

## Exposing it to the internet

Know what you are exposing: the backend talks to the host's Docker socket and
runs uploaded server packs. Someone who gets past the login does not "restart a
Minecraft server", they run code on the host. Gate it accordingly.

**1. Put an identity proxy in front (Cloudflare Access, or equivalent).** The
shared password is one guessable secret with no MFA and no per-person
revocation. Cloudflare Access sits in front of the tunnel, authenticates against
a real IdP (Google / GitHub / email OTP), and drops everything else before it
ever reaches Express. Free for up to 50 users, and it is the whole "who is
allowed in" problem solved without a users table.

**2. Serve the UI and API from one hostname.** MC Dash is a browser app on :3000
calling an API on :4000. Give each its own public hostname and Access will
302 the API's XHRs to a login page that CORS then blocks — the app appears to
hang at "Could not reach the server". Put a small reverse proxy (Caddy/nginx) on
the host instead, route `/api/*` to :4000 with the prefix stripped and
everything else to :3000, and point the tunnel at the proxy. Then set
`NEXT_PUBLIC_API_BASE_URL=/api` and rebuild the frontend.

**3. Mind the request body limit.** Cloudflare caps request bodies at 100 MB on
Free and Pro (200 MB on Business); nginx defaults to 1 MB. Server packs pass
100 MB routinely. The failure is often silent rather than loud: the proxy stops
reading the socket while the connection stays open, so the browser's progress bar
parks a few megabytes in and no error ever reaches the page.

Note this is a limit on the *request* body only — responses are unrestricted,
which is why a multi-gigabyte snapshot downloads fine from the same host that
refuses a 200 MB upload.

MC Dash handles this by never sending a big file as one request: the browser
slices it and the backend reassembles the slices on disk. Slices start at 8 MB
and grow with the file (aiming for ~200 requests whatever its size), never
exceeding `MC_DASH_UPLOAD_CHUNK_MAX_MB` — 64 MB, comfortably under the 100 MB
ceiling. Nothing to configure, but if you impose your own limit anywhere in the
chain, keep it above that. If you front MC Dash with nginx, set
`client_max_body_size` generously anyway so the single-request path still works
for small files and for curl.

**4. Close the back door.** The tunnel is pointless if :3000/:4000 are also
reachable directly.

```bash
MC_DASH_BIND_HOST=127.0.0.1     # backend binds loopback only
MC_DASH_TRUST_PROXY=loopback    # real client IP from X-Forwarded-For
MC_DASH_COOKIE_SECURE=true      # you are on HTTPS now
MC_DASH_FRONTEND_ORIGIN=https://<your-hostname>
```

Bind the frontend to loopback too (`next start -H 127.0.0.1`) and verify from
another machine that `http://<host-ip>:3000` and `:4000` both refuse. Note the
ordering: set `MC_DASH_TRUST_PROXY` **only** once the port is unreachable
directly, otherwise anyone can forge `X-Forwarded-For` and walk past the login
throttle.

**5. Know the revocation story.** Sessions are stateless signed cookies with a
7-day TTL. Changing `MC_DASH_PASSWORD` does **not** log anyone out — rotating
`MC_DASH_SESSION_SECRET` (and restarting) is what kills every live session.

## Troubleshooting

- **Dashboard loads but every action says "can't reach backend"**: the baked-in
  `NEXT_PUBLIC_API_BASE_URL` is wrong. It's set at *build* time — after changing
  `.env` you must rebuild: `docker compose up -d --build`.
- **Login seems to work then immediately logs out**: cookie was dropped. Ensure
  `MC_DASH_COOKIE_SECURE=false` when serving over plain HTTP, and that
  `MC_DASH_FRONTEND_ORIGIN` exactly matches the URL in your browser bar.
- **Upload freezes at a low percentage and never errors**: something between the
  browser and MC Dash is refusing the request body and has stopped reading the
  socket, so the browser sits on a connection that is open but going nowhere. On
  Cloudflare that is the 100 MB plan limit; on nginx it is `client_max_body_size`,
  which defaults to a mere 1 MB. Check what the proxy saw:

  ```bash
  sudo tail -f /var/log/nginx/error.log     # nginx
  journalctl -u cloudflared -f              # Cloudflare Tunnel
  ```

  Uploads are chunked at `MC_DASH_UPLOAD_CHUNK_MB` (8 MB) precisely so no request
  is large enough to hit these limits — if you are still seeing this, something in
  the chain is capping bodies below that, or you are on a build from before
  chunking landed.
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

- **Server exits immediately and the pack log says the modloader "is not
  available" for your Minecraft version**: usually a lie. Server pack start
  scripts fetch the modloader jar with `curl`/`wget`, bare JRE images ship with
  neither, and a failed download looks identical to "not available". MC Dash
  handles this by building a derived image (`mc-dash/java:<base>`) that adds
  curl on top of the resolved Java image — at *build* time, since containers
  run unprivileged and can no longer install packages at runtime. If that build
  can't run, MC Dash now fails with the real reason instead of letting the pack
  mislead you. Point the server's Java image at a base that already includes
  curl, or give the Docker daemon access to your package mirrors.

  Don't reach for `MC_CONTAINER_USER=root` to fix this — it would make the
  runtime install work again at the cost of root-owned world files, i.e. the
  snapshot breakage above. Reserve it for packs that genuinely need root *inside*
  the container for their own reasons, and then run MC Dash as root too (e.g. the
  compose stack) so it can still read the files back for snapshots.
