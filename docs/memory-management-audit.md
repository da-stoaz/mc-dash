# RAM management audit — 2026-10-23

Baseline: `94eb7a7` on `codex/shared-ram-management`. This is a source and local
logic audit, not verification of the Ubuntu deployment. No runtime policy was
changed during this audit.

## Step 1 implementation update

The first implementation pass now refreshes admission readings after Docker and
host checks, reconstructs boot allowances from Docker readiness during auditing,
and removes their unconditional timeout. Confirmed-ready or stopped containers
release their allowances. Unknown readiness remains conservative.

Pressure shutdowns recheck after status refresh and after saving, before stop.
Running-container RAM reductions are deferred; the desired limit is applied on
the next stopped-container start. The existing restart-required flag indicates
that saved configuration is pending. CPU updates remain live.

63 focused tests pass, including new regressions for stale admission, countdown
recovery, the post-save veto, deferred RAM reductions, and boot reconstruction.
Backend TypeScript compilation also passes. Continuous monitoring during an
intervention and unified lifecycle coordination remain step 2; Linux runtime
verification remains outstanding. Findings below describe the audit baseline.

## Intended behavior

- One configurable ceiling for all managed Minecraft workloads together.
- MC Dash's controller and UI remain outside that ceiling.
- Servers share unused capacity; configured per-server maxima are not fully reserved.
- Detect trouble early enough to save and sleep servers gracefully, preferring
  empty servers and warning affected players.
- Keep the UI understandable: used RAM / total limit, protection status, and an
  explanation when an action is blocked or a server is being slept.

## What exists

| Functionality | Implementation | Assessment |
| --- | --- | --- |
| Shared ceiling | `deploy/systemd/minecraft.slice`, `memoryPool.ts`, Docker `CgroupParent` | Structural foundation exists. Installed `memory.max` is authoritative; limit changes are manual host configuration. Default is 12 GiB, labelled GB in the UI. |
| Panel separation | Compose leaves backend/frontend outside; backend membership and known Docker containers are checked | Correct intended placement. This protects against the Minecraft group's OOM, not host-wide exhaustion. Actual Linux placement still needs verification. |
| Sharing unused RAM | Start gate uses current pool usage plus a boot allowance, not the sum of server maxima | Correct direction; admission and boot accounting have gaps below. |
| Per-server boundaries | Docker memory cap includes JVM overhead; heap min/max are rewritten for supported launch formats | Present. Arbitrary pack scripts can still override JVM options; effective heap settings are not verified. |
| Releasing unused heap | Elastic JVM tuning, including G1 periodic collection for compatible runtimes | Can help return unused heap. Cannot repair a leak retaining live objects. |
| Pressure response | 10-second polling; at 85%, seek servers empty for a minute; at 90%, warn an occupied candidate for 60 seconds | Implemented, but incomplete as a safety controller. |
| Graceful sleep | Recognized `save-all flush` acknowledgement, RCON `stop`, confirmed clean exit | No forced-stop fallback for automatic sleep. Modpack compatibility and real save/exit behavior remain unverified. |
| Wake | Sleeping listener and admission-gated wake-on-connect | Normal automated wake restores sleep on refusal; manual-start failure has a gap. |
| User feedback | Usage/limit, verification reason, temporary latest-action message | No durable intervention history; OOM counters are read but not handled. |

## Confirmed logic gaps

The existing focused tests all pass, but an additional temporary harness using
the actual service classes and mocked dependencies reproduced these cases:

1. **Outdated admission reading.** `DockerService.start()` reads the pool before
   awaiting Docker auditing and inspection. The gate still uses that reading
   after usage has risen. Refresh measurements immediately before admission;
   retain operating headroom because no userspace check can prevent subsequent growth.
2. **Unconditional boot timeout.** `StartupReservations` drops an allowance after
   120 seconds without checking readiness. Slow modpacks can still be booting.
   Track and reconcile actual startup state; recover it after backend restarts.
3. **Shutdown after recovery.** An expiring occupied-server countdown executes
   even if usage recovers during the awaited status refresh. There is also no
   pressure recheck after saving, immediately before sending `stop`.
4. **Monitoring pauses during intervention.** The controller awaits the entire
   save/exit operation with its `busy` flag held. Subsequent ticks do not sample
   pressure until that operation finishes. Monitoring and intervention progress
   need separate state while preserving per-server exclusion.

These are logic reproductions, not induced Linux OOMs or real Minecraft tests.

## Additional source-level problems and omissions

- **Live RAM reductions can be unsafe.** The settings route calls
  `updateResources()` immediately. There is no guard against lowering a running
  container's cap below its usage or its existing JVM heap configuration.
  Stage RAM reductions for a controlled restart; distinguish pending settings
  from effective runtime limits.
- **Verification differs by caller.** The capacity API audits Docker membership;
  the pressure controller uses the lower-level cgroup reader directly. It can
  treat protection as verified when the API does not, or select a server outside
  the capped group. Use one verified pool/membership snapshot consistently.
- **Only aggregate pool pressure triggers action.** A JVM can approach its own
  heap/container limit while the shared pool is mostly empty. Other deployments
  can exhaust host RAM while the Minecraft pool stays below its ceiling. Host
  free memory is checked at startup, not continuously by this controller.
- **Reaction time is not budgeted.** Fixed thresholds and a 60-second warning,
  followed by saving and shutdown, can leave too little time for a growing
  workload. There is no growth-rate or measured shutdown-duration model. A
  successful sleep imposes another minute's cooldown regardless of remaining
  severity. No `MemoryHigh` reclaim/throttling threshold is configured.
- **Restart and failure recovery are incomplete.** Countdown/boot state is
  process-local. A clean exit after the sleep timeout is not reconciled into
  hibernation. A failed manual start releases the sleeping listener without
  restoring it. Automatic sleep/wake and manual lifecycle actions have different
  locks. Immediate wake after pressure sleep can lead to repeated cycling.
- **Not all workloads pass admission.** Image probes/builds request the pool
  parent but do not use the server start gate or boot allowances. Their actual
  resource placement and impact need checking with the deployed Docker builder.
- **Compatibility is assumed in important places.** Supported pack files are
  rewritten, but effective JVM options are not inspected. Save acknowledgement
  matching accepts only “Saved the game/world”; other responses fail closed.
  Starting or unresponsive servers cannot use the normal graceful relief path.
- **Activation is not an explicit migration.** The feature defaults on for Linux
  and in Compose. Without the slice or rebuilt containers, an upgrade can block
  starts. Setup must be an explicit, verified rollout before enabling enforcement.

## Implementation order and resulting functionality

1. **Make current operations safe.** Add permanent regression tests for the four
   reproduced gaps; fix fresh admission, boot reconciliation, shutdown recovery
   checks, and staged RAM reductions. Result: avoid incorrect starts, avoidable
   shutdowns, and dangerous live limit changes.
2. **Unify lifecycle and monitoring.** Use consistent verified membership, shared
   per-server lifecycle ownership, continuous sampling during interventions, and
   recovery of pending operations/listeners after failure or backend restart.
   Result: predictable save/sleep/wake behavior under concurrency and failures.
3. **Make prevention proactive.** Include host and per-server pressure, effective
   JVM limits, usage growth, observed boot peaks and save/exit durations. Prefer
   empty servers, begin occupied warnings early, and prevent immediate wake
   cycling. Result: share capacity based on measured demand while retaining time
   to intervene. Do not promise arbitrary memory growth can always be handled gracefully.
4. **Finish configuration and visibility.** Keep one authoritative shared limit,
   explicit activation/migration, clear pending/effective settings, consistent
   units, and durable reasons for interventions. Avoid exposing competing totals
   in the primary UI.
5. **Prove the deployment behavior on disposable Ubuntu.** Verify actual cgroup
   membership, aggregate enforcement, panel responsiveness, representative
   modpack save/reload, slow boots, concurrent starts, unavailable RCON, backend
   restarts, host pressure, and a server nearing its individual limit. This is a
   prerequisite for calling the system production-ready.

## Verification performed

58/58 existing tests passed locally:

```sh
cd backend
node -r ts-node/register --test \
  src/services/memoryPool.test.ts \
  src/services/memoryPlan.test.ts \
  src/services/hostCapacityService.test.ts \
  src/services/jvmTuning.test.ts
```

The four additional reproductions used a temporary mocked harness, not permanent
regression tests. No Ubuntu runtime, real memory-pressure exercise, or modpack
world integrity test was performed in this audit.

The OS ceiling is an emergency boundary: `memory.max` can invoke cgroup OOM and
can be temporarily exceeded in some conditions. `memory.high` introduces reclaim
and throttling, not a guarantee of graceful survival. See the
[kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).

Deployment instructions and the previous implementation description are in
[memory-pool.md](memory-pool.md). The gaps above qualify its behavioral claims,
especially cancellation on recovery, verification, and boot allowance lifetime.
