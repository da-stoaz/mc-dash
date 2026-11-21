# Minecraft router security

Recorded 2026-10-22; re-audited and prioritised 2026-11-20.

Covers the public hostname router (`backend/src/services/routerService.ts`) and
everything it hands connections to: the sleep gateway, wake-on-connect and the
Docker-published game ports. It is the only unauthenticated, internet-facing
surface of MC Dash.

These are code/configuration findings. A deployment's actual exposed ports
(IPv4 and IPv6), firewall rules, NAT/gateway forwards, origin restrictions and
provider-side DDoS protection have **not** been audited here. Do not assume
either zero upstream protection or a protected origin from this note; use the
host audit checklist below for each deployment.

## Findings by priority

Severity assumes an unauthenticated attacker who can reach the router port.
"Verified" means reproduced against the real `RouterService` over local
sockets; the rest come from reading the code.

| ID | Severity | Status | Finding | Fixed by |
|---|---|---|---|---|
| R1 | Critical | **Fixed** 2026-11-20 (verified) | One connection could crash the whole backend | — |
| R2 | High | Open | Router shares a process with the Docker socket | PR 4 |
| R3 | High | Open | Game ports and sleep listeners bypass the router | PR 2 |
| R4 | High | Open | No connection bounds | PR 1, PR 3 |
| R5 | Medium | Open (verified) | Junk and silent connections are forwarded to the default server | PR 1 |
| R6 | Medium | Open | Wake-on-connect is unauthenticated and barely throttled | PR 3 |
| R7 | Medium | Open | Client IPs are lost behind the router | PR 3, PR 5 |
| R8 | Low | Open | Handshake parser is lenient | PR 3 |
| R9 | Low | Open | Upstream connections have no deadlines | PR 3 |
| R10 | Low | Open | Per-connection logging | PR 1 |

### R1 — Critical — single-connection backend crash (fixed)

Every reject path (unknown hostname, oversized or unparseable handshake,
handshake timeout) called `socket.end()` and then stripped all of the socket's
listeners, including `error`. A client that reset the connection afterwards
raised an uncaught `ECONNRESET` and the process exited, taking the dashboard API
and any in-flight snapshot, restore or backup with it. The restart policy does
not help: one packet per second keeps the backend down.

Fix: rejected sockets are destroyed; the client socket keeps its `error`
listener for its whole life; an upstream error destroys the client. Regression
tests in `backend/src/services/routerService.test.ts` reset the connection after
each kind of rejection.

### R2 — High — router shares a process with the Docker socket

The router starts inside the API process (`backend/src/index.ts`), which mounts
`/var/run/docker.sock` (root-equivalent on the host) and the data directory. Any
bug in the internet-facing parser path runs with that reach, and router load
(event loop, file descriptors, memory) degrades the panel.

### R3 — High — game ports and sleep listeners bypass the router

`dockerService.ts` publishes each server's game port without a `HostIp`, so
Docker binds it on all IPv4 and IPv6 addresses. Docker's NAT rules are evaluated
before ufw's input rules, so ufw does not block them. `SleepListener.listen()` in
`sleepGateway.ts` also binds all interfaces. Anyone can skip the router, and
every control added to it, by connecting to a server's own port. Docker before
28.0 also lets hosts on the local network reach ports published on 127.0.0.1.

### R4 — High — no connection bounds

No global connection cap (`maxConnections`), no per-IP concurrency limit and no
connection-rate limit. Each socket costs a file descriptor, a timer and up to
8 KB of buffer in the API process, and the backend container has no memory
limit. A flood leads to `EMFILE` and memory pressure, and then the API and
Docker calls fail.

### R5 — Medium — junk and silent connections forwarded (verified)

With `MC_ROUTER_DEFAULT_SUBDOMAIN` set, unparseable bytes (for example an HTTP
request) are forwarded verbatim to the default server. A client that never
sends anything gets an upstream game connection after the 5 s handshake timeout.
Each idle client then costs two sockets plus a game-server login slot until the
game server times it out.

### R6 — Medium — wake-on-connect abuse

`hibernationService.wake()` is guarded only by a per-server busy flag. Any
join-state handshake for a sleeping subdomain, or to a sleeping server's own
port, starts it. Scanners can keep servers permanently awake, which defeats
hibernation, and a refused wake (for example memory admission) is retried on
every new connection.

### R7 — Medium — client IPs are lost

The game server sees every routed player as `127.0.0.1`. Server-side IP bans,
IP logging and per-IP limits do not work. `ban-ip <player>` on a routed server
bans `127.0.0.1`, which locks out every player who connects through the router.

### R8 — Low — lenient handshake parser

`readVarInt` accepts a fifth byte that sets the sign bit, so lengths can be
negative. Nothing caps the declared packet length (only the 8 KB buffer) or the
hostname at the protocol's 255 characters. `nextState` is not validated, and
nothing checks that the packet ends where its length says. Malformed input mostly
ends in a thrown error, which today feeds R5's fallback forwarding.

### R9 — Low — upstream connections have no deadlines

`connectUpstream()` has no connect timeout, no idle timeout and no TCP
keepalive. Data a client sends between the handshake and the upstream `connect`
event is dropped. This is latent and did not reproduce over loopback.

### R10 — Low — per-connection logging

Every handshake logs an `info` line with the remote IP and port, and every
unresolved hostname or parse failure logs a warning. A flood becomes a disk
flood, and client IPs in logs are personal data.

## Plan, in order

**PR 1 — remaining hotfixes (R5, R4, R10).**
- Reject parse failures, oversized handshakes and timeouts instead of
  forwarding them. The default subdomain applies only to a *valid* handshake
  for the bare router domain.
- Global connection cap plus a per-IP concurrency cap. Make both configurable,
  with defaults generous enough for players sharing a household IP.
- Per-connection logs move to `debug`. Write one aggregated warning per interval
  with reject counts by reason.

**PR 2 — close the bypasses (R3).**
- When routing is enabled, publish game ports with `HostIp: 127.0.0.1` (no
  IPv6) and bind sleep listeners to `MC_ROUTER_TARGET_HOST`. An explicit opt-out
  (for example `MC_DIRECT_PORTS=true`) keeps direct-connect setups working.
- Migrate existing containers on their next start: inspect `PortBindings` and
  recreate on mismatch, following the `shouldRecreateForUser` pattern.
- Run the host audit checklist below.

**PR 3 — admission control and strictness (R4, R6, R7, R8, R9).**
- Token buckets for new connections per IP, per prefix (/24 for IPv4, /64 for
  IPv6) and overall. Separate caps for handshaking and established sockets.
- Strict parser: VarInt range checks, a packet length cap of about 1–2 KiB
  (checked against Forge/NeoForge hostname suffixes), hostname ≤ 255 plus known
  markers, `nextState` ∈ {1, 2, 3}, and an exact packet end. Fuzz tests: random
  bytes never escape as an exception and never hang.
- Upstream:
  - Pause the client until the upstream connects, so no bytes are lost.
  - 3 s connect timeout, plus TCP keepalive.
  - 60 s idle timeout. Servers send keepalives every 15 s, so live players are
    unaffected.
  - Tear down both sides together.
- Wake:
  - Per-server cooldown with backoff after a refused or failed wake, and a
    per-IP wake budget.
  - An optional known-players-only gate that reads the Login Start name and
    wakes only for whitelisted, op or recently seen players. Names can be
    spoofed, but scanners do not know them.
- IPs:
  - A router-level deny list managed in the dashboard.
  - Enforce each server's `banned-ips.json` at the router.
  - Warn on or block `ban-ip` for routed servers.

**PR 4 — isolate the router (R2).**
- Own entrypoint and compose service from the same image: host networking, **no
  Docker socket and no data directory**, a non-root user, `cap_drop: [ALL]`, a
  read-only root filesystem, and memory, pids and `nofile` limits.
- Loopback-only control channel with a shared secret. The backend pushes the
  routing table (subdomain → port, hibernation state, MOTD). The router asks the
  backend to wake, and the backend applies its throttles again.
- The router keeps the last table it received, so players can still join running
  servers while the panel restarts or upgrades.
- Router health and counters (active connections, rejects by reason, wakes) shown
  in the dashboard.
- Build it in-repo rather than adopting an external router: the sleep, wake and
  admission behaviour is custom, and the protocol slice is small. itzg/mc-router
  is still a useful feature checklist.

**PR 5 — kernel and upstream layer (R4, R7).**
- nftables rules shipped in `deploy/`:
  - per-source connection count and new-connection rate limits on the router port
  - an explicit drop of the game port range from outside
  - IPv6 parity, and SYN cookies on
- Evaluate a protecting TCP proxy: TCPShield, Cloudflare Spectrum, playit.gg, or a
  VPS with a WireGuard tunnel. Local controls cannot stop an uplink from being
  saturated, and a proxy also hides the origin IP.
  - Accept PROXY protocol v2 only from the provider's address ranges.
  - Forward the router port only from those ranges.
  - Optionally send PROXY v2 to servers that support it (Paper natively,
    Forge/Fabric through mods) to restore real player IPs.

## Host audit checklist (per deployment)

- Listening sockets on IPv4 and IPv6 (`ss -tlnp`); only the router port and
  intended services should be public.
- Docker version ≥ 28.0, and the `DOCKER-USER` chain rules.
- NAT/gateway port forwards and the IPv6 firewall on the gateway.
- An external scan of IPv4 and IPv6 from outside the local network.
- Dashboard ports reachable only through the intended proxy or tunnel, not
  directly.

## Validation before calling it protected

Use controlled local or disposable test environments and verify:

- no single client can crash or stall the backend (fuzz and reset tests in CI)
- connection and memory bounds hold under bursts and slow or incomplete
  handshakes, for example 10k idle sockets
- normal joins, pings and reconnects still work, and no sockets leak
- wake attempts per server stay bounded whatever the traffic
- backend ports are private, and an external scan shows only the intended ports
- the panel stays responsive while the router is overloaded (after PR 4)

Test deployment networking on Linux. Application hardening alone must not be
described as volumetric DDoS protection.

## Open decisions

1. Router as a separate compose service (recommended) or a child process in the
   backend container.
2. Upstream protection provider and budget, or none for now.
3. Known-players-only wake: on by default, or opt-in.
4. Whether any deployment needs direct-port access (decides PR 2's default).

## Related decisions

The current router routes by hostname; it does not authenticate players or
enforce whitelist/blacklist entries. Immediate bans are sent to Minecraft over
RCON. A maximum-player setting does not protect against connection floods.

Cloudflare's normal website proxy does not cover Minecraft on port 25565.
Spectrum is a separate TCP/UDP protection product; deployment, compatibility,
plan availability, and origin restrictions need evaluation before choosing it.

References:

- [Cloudflare supported proxy ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/)
- [Spectrum DDoS protection](https://developers.cloudflare.com/spectrum/about/ddos-for-spectrum/)
- [Protecting proxy backend servers](https://docs.papermc.io/velocity/security/)
