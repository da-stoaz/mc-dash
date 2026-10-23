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

Build/restart the updated app through your normal deployment process. Rebuild
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

## Current pressure behavior and its limits

In addition to the static pool thresholds below, sustained growth can start the
warning earlier. The controller also watches host available RAM and each server's
actual Docker memory limit. Host headroom is the greater of the configured floor
and 10% of host RAM. An individual-server warning targets that server. Trend
samples must show sustained growth; the lookahead allows for the player warning,
saving and shutdown. These heuristics still need Ubuntu workload validation.

A server slept for pressure cannot restart for five minutes. After that, admission
accounts for its observed pre-sleep usage, rather than just its configured minimum.
This state survives backend restarts and applies to manual and player-triggered
starts. Reducing the configured server maximum bounds that historical demand.
Effective JVM heap settings are not yet inspected.


- Starts are serialized and use current pool usage plus temporary boot
  allowances, not the sum of configured maximums. Boot allowances are rebuilt
  from Docker readiness checks and do not expire solely because time passed. Starts are refused when that
  would consume the 15% operating margin. Host free memory is checked separately.
  Wake-on-connect and restart use the same gate; `force` cannot bypass it.
- At 85% usage, MC Dash checks for empty servers every ten seconds. After a
  minute of confirmed zero players, it saves and sleeps the largest eligible
  server. Unknown counts do not count as empty. Player counts are rechecked
  before and after saving; there is still a small join/shutdown race.
- At 90%, if no confirmed-empty server can be slept immediately, MC Dash warns
  one server's players with a 60-second countdown and a reminder at 30 seconds.
  It selects the fewest known players, then the largest memory consumer.
  Unknown player counts rank last and still require a successful warning.
  It does not shorten the promised countdown as usage rises.
- A countdown cancels if usage drops below 85%, protection becomes unverified,
  or the selected server stops/is replaced. This gap between warning and
  recovery thresholds avoids repeatedly starting/cancelling near 90%.
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

References: [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
[Docker cgroup parent](https://docs.docker.com/reference/cli/dockerd/#default-cgroup-parent).
