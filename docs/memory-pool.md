# Minecraft memory pool — panel stays outside

The checked-in [minecraft.slice](../deploy/systemd/minecraft.slice) is a plain
systemd resource configuration. It contains the **Minecraft containers' shared
12 GiB ceiling** (`MemoryMax=12G`, shown as GB in the UI) and disables swap for
that group. It does not reserve 12 GiB up front.

**MC Dash's backend and frontend must stay outside this pool.** Exhausting the
Minecraft pool must not make the panel eligible for that pool's OOM kill. The
backend refuses to report protection as verified if its own membership puts it
inside the Minecraft pool or the superseded `mcdash.slice` group. Known MC Dash
Docker containers are checked too. Host-wide memory exhaustion is a separate
risk: leave headroom for the panel, Docker, Ubuntu, and other deployments. On a
14.5 GB machine, a 12 GiB Minecraft ceiling leaves little room for those services.

There is no installer script, generated environment file, or automatic service
rewrite. The application reads the installed `memory.max` as the source of truth.
There is no `MC_DASH_MEMORY_LIMIT_MB` setting to keep in sync. Existing per-server
maximums are ceilings, not reservations against the whole pool.

The dashboard's **RAM limit (MiB)** is the total per-container Docker limit.
Java heap and native overhead fit inside it: 10,000 MiB sets Docker's limit to
10,000 MiB and, with default overhead settings, permits a maximum Java heap of
8,696 MiB. The initial heap is clamped to this heap budget. This allowance is an
estimate; native memory can still exhaust a container even when its heap fits.

Existing records migrate once from the old heap-based maximum to their previous
total container ceiling. For example, an old 8,192 MiB heap setting becomes a
9,421 MiB RAM limit, retaining the same heap budget and learned startup demand.
The migration does not change running Docker containers or their files. Changes
to a server's RAM settings still require a restart to apply Java heap changes;
Docker limit reductions are deferred until the container stops. Back up the
database before upgrading; a rollback to the old code needs its matching database
backup because the meaning of the stored maximum has changed.

## Status of this implementation

See the [2026-10-23 implementation audit](memory-management-audit.md) for confirmed
logic gaps, incomplete functionality, and the implementation priorities. The
behavior described below is not yet a production-readiness claim.

Local tests validate the controller reader, Docker request construction/auditing,
start admission, pressure decisions, and UI with fixtures. **The Linux runtime
behavior has not been exercised on the Ubuntu deployment.** Player warnings, cancellation on recovery, and graceful occupied-server sleep
are implemented and covered by local tests. Their real RCON, disk-flush, and
cgroup behavior still needs an end-to-end Linux exercise.
The kernel ceiling is an emergency boundary; it must not be presented as a
promise that Minecraft servers cannot crash under pressure.

## Explicit Ubuntu configuration

Requires a local, rootful Docker daemon with its **systemd cgroup driver and
cgroup v2**. Confirm with `docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}'`.
The expected result is `systemd 2`. Rootless/remote Docker and Docker Desktop
aren't supported for verification of this systemd configuration. Development on
macOS continues to show actual Minecraft usage in monitoring-only mode.

Before migrating, stop the Minecraft servers gracefully. Review the unit, copy
it, choose the total ceiling, and activate it explicitly:

```sh
sudo install -m 0644 deploy/systemd/minecraft.slice /etc/systemd/system/minecraft.slice
sudoedit /etc/systemd/system/minecraft.slice
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft.slice
```

These commands configure only the Minecraft slice. Do **not** add
`Slice=minecraft.slice` to MC Dash's service units. Do **not** add
`cgroup_parent: minecraft.slice` to the backend or frontend Compose services.
The backend needs the host cgroup namespace and read-only cgroup mount to verify
membership; the supplied Compose file provides these without putting it in the
Minecraft pool. A systemd-hosted backend already sees host membership.

Production Compose enables shared enforcement by default; local npm development
keeps it disabled by default. After stopping the Minecraft servers and
installing/verifying the host slice, ensure `MC_DASH_MEMORY_POOL=true` in the
root `.env`, then recreate the backend with
`docker compose up -d --wait backend` (a plain restart does not reload `.env`). Rebuild
each stopped Minecraft server in MC Dash so its Docker container is recreated
with the correct parent. Worlds are preserved by the existing rebuild workflow.
Legacy containers are refused on start, not silently accepted outside the pool.
The panel remains available to inspect errors and stop servers even when pool
verification fails. It never reconfigures cgroups or moves host services itself.

To change the limit later, stop the Minecraft containers first, edit
`MemoryMax` in the installed unit, reload systemd and restart **the slice**, then
start the servers again. Never restart an occupied slice or lower a live limit
below usage as a substitute for graceful shutdown. MC Dash reads the new value
on its next poll, so no second application setting is required.

## If the previous draft setup was applied

Nothing in this workspace applied it to the Ubuntu host. If it was run manually,
inspect the service drop-ins first:

```sh
systemctl cat mc-dash-backend.service
systemctl cat mc-dash-frontend.service
```

Remove only the old draft's `memory-pool.conf` drop-ins assigning these services
to `mcdash.slice` and loading `/etc/mc-dash/memory.env`. Reload systemd and restart
those application services so they leave the old pool. For Compose, recreate
the backend/frontend using the revised Compose file, which has no pool parent.
Stop and rebuild old Minecraft containers into `minecraft.slice`. After checking
that `mcdash.slice` is empty, its old unit, generated drop-in settings, and unused
environment file can be retired. Do not stop a populated old slice: that could
terminate the applications still in it.

## Startup demand learning

The metrics collector persists observed working-set RAM peaks (excluding inactive file cache) while a server is starting or
restarting, and during the first two minutes even if it became ready sooner.
Subsequent starts budget the greater of the configured minimum plus overhead and
that peak plus 10%, bounded by the container ceiling. Measurements are keyed by
server, RAM settings, pack URL, and Java image. These are sampled estimates, not
a guarantee that the next boot cannot exceed the forecast. New configurations
still begin with their configured floor until observations are available.
Docker auditing preserves larger outstanding boot allowances and reconstructs
learned and recent pressure-restart demand after a backend restart. Legacy boot
and pressure observations that included file cache are ignored when admitting starts.
The dashboard shows working-set usage and lists reclaimable file cache separately;
cache can remain charged to the pool after the JVM exits.

## Current pressure behavior and its limits

`MC_DASH_HIBERNATE=false` (the default) disables **all automatic sleep**,
including pressure shutdowns. Shared and per-container kernel limits still apply,
and start admission remains active while `MC_DASH_MEMORY_POOL=true`. Existing
sleepers can still wake; failed wake-listener binds are retried every 30 seconds
even with automatic sleep disabled.
Status refresh also runs with the shared manager disabled and no dashboard open.
It ignores Docker readings that became stale during a lifecycle operation, and
clears the sleep flag when Docker confirms a server was started externally.
Restart releases a sleeping server's listener before starting Docker and restores
it if admission fails. The wake-on-connect switch applies to subdomain routing too.

When automatic sleep is enabled, sustained growth can start the warning earlier
than the static thresholds below, but only above 85% of the warning boundary. The controller also watches host available RAM and each server's
actual Docker memory limit. Host headroom uses the configured `MC_DASH_HOST_FREE_FLOOR_MB` floor. An individual-server warning targets that server. Trend
samples must show sustained growth; the lookahead allows for the player warning,
saving and shutdown. These heuristics still need Ubuntu workload validation.

A pressure-slept server can restart immediately if current capacity fits its
startup demand. For five minutes, admission also accounts for its most recent
pre-sleep working set, bounded by its configured limit. This allowance expires
and is replaced by each new pressure sleep; it is not a timed start prohibition.
Legacy cache-inclusive demand is ignored. Disabling `MC_DASH_MEMORY_POOL` skips
this shared-manager gate, including its persisted recovery demand.
Effective JVM heap settings can be inspected on demand through the runtime diagnostic below.

Local socket regressions exercise both direct-port and subdomain-router wakes
through the hibernation service and shared-memory admission: refusal, continued
status replies, retry after capacity recovers, and rebinding the game to the
released port. Docker and cgroup readings are simulated in these tests; they do
not replace the outstanding Ubuntu runtime exercise.


- Starts are serialized and use current pool usage plus temporary boot
  allowances, not the sum of configured maximums. Boot allowances are rebuilt
  from Docker readiness checks and do not expire solely because time passed. Starts are refused when that
  would consume the 5% startup margin. Host free memory is checked separately.
  Wake-on-connect and restart use the same gate; `force` cannot bypass it.
- At 97% working-set usage (or a qualifying near-limit trend), MC Dash checks for empty servers every ten seconds. After a
  minute of confirmed zero players, it saves and sleeps the largest eligible
  server. Unknown counts do not count as empty. Player counts are rechecked
  before and after saving; there is still a small join/shutdown race.
- At the same pressure boundary, if no confirmed-empty server can be slept immediately, MC Dash warns
  one server's players with a 60-second countdown and a reminder at 30 seconds.
  It selects the fewest known players, then the largest memory consumer.
  Unknown player counts rank last and still require a successful warning.
  It does not shorten the promised countdown as usage rises.
- A countdown cancels when pressure and qualifying trends recover, automatic
  sleep is disabled, protection becomes unverified, or the selected server
  stops/is replaced.
  The dashboard's existing RAM summary shows the countdown or latest result.
- Automatic sleep uses `save-all flush`, requires a recognized successful save
  response, sends RCON `stop`, and waits up to 60 seconds for a clean exit.
  There is **no Docker stop/kill fallback** for automatic hibernation, whether
  caused by idleness or pressure. Failed, missing, or unrecognized save responses
  cancel shutdown. Slow/failed exits remain visible as errors, never reported
  as a successful sleep. Modded save acknowledgements other than "Saved the
  game/world" currently fail closed.
- Pressure sampling continues during saving and shutdown; another intervention
  is not scheduled while one is in flight. Manual lifecycle operations and
  automatic sleep/wake share per-server ownership.
- Successful sleeps have a one-minute cooldown before another intervention.
  Critical pressure can bypass the successful-sleep cooldown. Failed attempts
  are retried no sooner than one minute after the attempt finishes for that server.
  Sleeping servers wake only through the normal capacity gate. Pressure polling
  refreshes Docker status independently of browser connections.
- Countdown state is in memory: restarting the backend starts a fresh warning
  period if pressure persists. A shutdown that finishes after the exit timeout
  is reconciled into hibernation only after the same container has a confirmed
  clean exit. Shutdown intent survives backend restarts.
- Elastic JVM heaps can release unused objects. They cannot repair a leak that
  retains live references. Sleeping a server clears its process memory.
- The kernel ceiling is still the emergency boundary. Sudden growth, unresponsive
  RCON, failed saves, or insufficient time to shut down can still cause Linux to
  OOM-kill **Minecraft processes inside the pool**. The panel is outside that OOM
  domain. Linux can also temporarily exceed `memory.max` in some circumstances;
  it is not a byte-exact instantaneous guarantee. No `MemoryHigh` throttling is
  configured by this unit.

## Verify the separation on Linux

```sh
cat /sys/fs/cgroup/minecraft.slice/memory.max
cat /sys/fs/cgroup/minecraft.slice/memory.swap.max
cat /sys/fs/cgroup/minecraft.slice/memory.current
systemd-cgls /minecraft.slice
systemctl show mc-dash-backend.service -p ControlGroup
systemctl show mc-dash-frontend.service -p ControlGroup
# For Docker-hosted apps and each Minecraft container:
docker inspect --format '{{.HostConfig.CgroupParent}}' CONTAINER_NAME
```

For 12 GiB, the maximum is `12884901888` bytes and swap maximum is `0`.
Minecraft containers belong to `minecraft.slice`; backend/frontend must not.
Custom frontend service names need the same manual check. No limit on a parent
shared with the panel should be used as the Minecraft budget.

Before production deployment, verify on a disposable Linux host that two test
Minecraft-like workloads sharing the pool cannot collectively grow unchecked,
and that an independently hosted panel stays reachable while the pool is under
pressure. Include failed saves, occupied servers, concurrent starts, and a
backend restart. These are outstanding runtime checks, not claims based on mocks.

The working-set calculation follows [Docker stats](https://docs.docker.com/reference/cli/docker/container/stats/): subtract `inactive_file` on cgroup v2.

References: [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
[Docker cgroup parent](https://docs.docker.com/reference/cli/dockerd/#default-cgroup-parent).

## Inspect the running JVM heap

`GET /api/servers/:id/memory-runtime` performs an on-demand diagnostic inside the
existing container, as its configured user. It selects exactly one Java process
and invokes its JDK's `jcmd PID VM.flags`. For JRE images without `jcmd`, the
backend copies its checksum-pinned static `jattach` helper into a private temporary
directory, requests the same flags, and removes the helper afterward. It does not
change flags, request GC, create a heap dump, install packages, or restart the server.

The response contains `status` (`verified`, `mismatch`, or `unverified`),
`initialHeapMb`, `maximumHeapMb`, `containerLimitMb`, `checkedAt`, and `reason`.
Values are MiB. Verification compares observed heap sizes with saved settings,
allowing JVM alignment tolerance. A pending restart is distinguished from a pack
argument override. A maximum heap consuming the entire container limit is a
mismatch because it leaves no room for native allocations.

An unavailable or incompatible helper on JRE images, multiple Java processes, unavailable `timeout`/`readlink`, denied
attach permissions, unsupported flag output, and container restarts during the
check produce an unverified result. The diagnostic process has a five-second
limit and output collection is capped. A verified result describes heap sizes
only; it does not prove leak resistance, sufficient native headroom, or successful
world saves. The server resource view exposes this through the collapsed “Check running
memory settings” section. Inspection does not automatically approve or block admission. Validate it against deployed JDKs and
modpacks before relying on its results.

Reference: [Oracle jcmd documentation](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html).

## JVM diagnostic verification (2026-10-30)

The integration test runs real non-root JVMs in disposable, network-isolated,
384 MiB Docker containers: Java 17 JDK, Java 17/21/25 JRE, and Java 25 with attach
disabled. It verifies heap sizes, detects intentional mismatches, preserves the
Docker-limit reading on attach failure, checks helper cleanup, and leaves the JVM
running. Run it explicitly after pulling those Temurin images:

```sh
docker build --target jattach -t mc-dash-jattach:inspection-check backend
cd backend
npm run test:jvm-integration
```

`DOCKER_SOCKET` can select the test daemon socket. The test removes only its own
containers and temporary files. These cases passed on local Docker Desktop.
They are **not** evidence for Ubuntu systemd enforcement.

Production enablement remains blocked until a disposable Linux/systemd deployment
completes all of these checks and records its versions/results:

1. Install a small test slice and verify actual process membership. Confirm both
   panel services and other deployments are outside it, including ancestor groups.
2. Boot two representative Minecraft packs concurrently. Compare observed usage,
   pending allowances and admission decisions; restart the backend mid-boot.
3. Exercise sustained and rapid growth, an individual-container limit, and low
   host headroom. Confirm warnings and graceful intervention occur as intended,
   and the panel stays available throughout. Exercise an abrupt allocation burst
   separately: an emergency OOM must never be misreported as successful sleep.
4. On disposable worlds, force RCON failure, failed save acknowledgement and slow
   shutdown. Confirm no automatic forced-stop fallback. Reopen each cleanly saved
   world and verify player/world changes survive.
5. Restart the backend during a countdown and during shutdown. Verify fresh
   warnings, recovery of clean late exits, and refusal to treat failed/OOM exits
   as hibernation. Exercise manual actions concurrently with automatic ones.
6. Verify the five-minute pressure cooldown, historical restart demand, ordinary
   boot-peak learning, and migration of stopped legacy containers.

No disposable Ubuntu host is currently available. None of the above Linux/world
checks have been claimed as passed. Keep shared enforcement disabled until they
are completed; the 12 GiB example also needs a host-specific budget review.
