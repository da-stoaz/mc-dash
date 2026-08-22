import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const dataRoot = process.env.DATA_ROOT
  ? path.resolve(process.cwd(), process.env.DATA_ROOT)
  : path.resolve(__dirname, '..', 'data');
const defaultSqlitePath = path.join(dataRoot, 'mc-dash.sqlite');

const homeSocket = process.env.HOME ? path.join(process.env.HOME, '.docker', 'run', 'docker.sock') : null;
const defaultDockerSocketPath = (() => {
  if (process.env.DOCKER_SOCKET_PATH) return process.env.DOCKER_SOCKET_PATH;
  const varRun = '/var/run/docker.sock';
  if (fs.existsSync(varRun)) return varRun;
  if (homeSocket && fs.existsSync(homeSocket)) return homeSocket;
  return varRun;
})();

const defaultServerPort = Number(process.env.MC_SERVER_PORT ?? 25565);
const serverPortMin = Number(process.env.MC_SERVER_PORT_MIN ?? defaultServerPort);
const serverPortMax = Number(process.env.MC_SERVER_PORT_MAX ?? defaultServerPort + 100);
const routerEnabled = String(process.env.MC_ROUTER_ENABLED ?? '').toLowerCase() === 'true';
const routerDomain = process.env.MC_ROUTER_DOMAIN ? process.env.MC_ROUTER_DOMAIN.trim().toLowerCase() : undefined;
const routerPort = Number(process.env.MC_ROUTER_PORT ?? 25565);
const routerTargetHost = process.env.MC_ROUTER_TARGET_HOST ?? '127.0.0.1';
const routerDefaultSubdomain = process.env.MC_ROUTER_DEFAULT_SUBDOMAIN
  ? process.env.MC_ROUTER_DEFAULT_SUBDOMAIN.trim().toLowerCase()
  : undefined;

// The uid:gid the per-server Minecraft containers should run as. By default we
// mirror the backend process's own uid/gid so every file a server writes into
// its bind-mounted data folder is owned by the same user that runs MC Dash.
// Without this, containers run as root and the (often non-root) backend can't
// read the world files back — snapshots, restores and deletes fail with EACCES.
//   - unset            -> host uid:gid of this process (0:0 when backend is root)
//   - "1000:1000"/"1000"-> used verbatim as Docker's `User`
//   - "root"           -> force root (opt-out; e.g. packs that apt-get install at
//                          runtime, which needs root inside the container)
// On platforms without getuid (Windows dev) this is undefined and we let Docker
// Desktop handle ownership.
export function resolveContainerUser(
  raw: string | undefined = process.env.MC_CONTAINER_USER,
  getuid: (() => number) | undefined = typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined,
  getgid: (() => number) | undefined = typeof process.getgid === 'function' ? process.getgid.bind(process) : undefined
): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed) {
    if (trimmed.toLowerCase() === 'root') return '0:0';
    return trimmed;
  }
  if (!getuid) return undefined;
  const uid = getuid();
  const gid = getgid ? getgid() : uid;
  return `${uid}:${gid}`;
}

// ---------------------------------------------------------------------------
// Memory management
//
// A Docker `Memory` limit is a *cap*, not a reservation: nothing stops the sum
// of every server's cap from exceeding physical RAM. Three servers capped at 8
// GB each fit fine on a 12 GB box while they idle, and take the box down the
// moment they all fill their heaps — first into swap, then into a freeze.
//
// So memory is managed on three levels, each with its own knobs below:
//   1. per-JVM    — keep the *idle* footprint small and give heap back to the
//                   OS (jvmTuning.ts)
//   2. per-cgroup — a hard cap, a soft floor, and no swap (dockerService.ts)
//   3. host-wide  — refuse to start a server whose cap doesn't fit in what's
//                   left of the budget (hostCapacityService.ts)
// ---------------------------------------------------------------------------

function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

// Held back for the OS, MC Dash itself and page cache; never handed to servers.
// 1.5 GB suits a small Linux host running only the dashboard — raise it if the
// box does anything else.
const memoryReserveMb = Math.max(0, envNumber(process.env.MC_DASH_HOST_RESERVE_MB, 1536));

// Admission is two-tier, the way a cluster scheduler is.
//
// The *guaranteed* tier is every running server's idle floor (min RAM plus JVM
// overhead) and is never overcommitted: whatever else happens, each running
// server can always have that much. That is the promise, and it costs 1.5 GB
// for a server whose ceiling is 6 GB.
//
// The *burst* tier is the sum of ceilings, and it is allowed to exceed physical
// RAM by this multiple. Booking every ceiling in full is what makes a strict
// ledger useless — a 12 GB host would run exactly one 6 GB server, even though
// three of them idle at 3 GB together and never peak at the same moment. The
// multiple is the bet you are taking on that "never at the same moment".
//
// 2.0 is a deliberate default rather than a neutral one: with container swap
// off (the default), losing the bet costs one OOM-killed server, not a frozen
// host. Set it to 1.0 to go back to strict worst-case admission.
const memoryBurstRatio = Math.max(
  1,
  envNumber(process.env.MC_DASH_MEMORY_BURST_RATIO ?? process.env.MC_DASH_MEMORY_OVERCOMMIT_RATIO, 2)
);

// Weigh a server's *observed* 7-day peak against its configured ceiling when
// deciding whether a start fits, instead of assuming every server always needs
// its full ceiling. Falls back to the ceiling whenever there isn't enough
// history to be evidence — see hostCapacityService.expectedPeakMb.
const memoryUseObservedPeaks = envBool(process.env.MC_DASH_MEMORY_USE_OBSERVED_PEAKS, true);

// How much headroom to add to an observed peak before trusting it. A server
// that topped out at 2.0 GB last week can still want more this week — a new
// modpack chunk, more players — so the figure the ledger uses is the observed
// peak plus this margin, never the bare observation.
const memoryObservedPeakMarginPercent = Math.max(
  0,
  envNumber(process.env.MC_DASH_MEMORY_OBSERVED_PEAK_MARGIN_PERCENT, 30)
);

// Minimum 30-minute buckets of history before an observed peak counts as
// evidence at all. 48 is a full day of uptime; below that the peak is far more
// likely to mean "hasn't been busy yet" than "doesn't need the memory".
const memoryObservedPeakMinSamples = Math.max(1, envNumber(process.env.MC_DASH_MEMORY_OBSERVED_PEAK_MIN_BUCKETS, 48));

// A JVM needs more than its heap: metaspace, code cache, thread stacks, GC
// bookkeeping and direct buffers all live *outside* -Xmx but inside the cgroup.
// Cap a container at exactly -Xmx and the kernel OOM-kills the server just as
// the heap fills. Both the container cap and the capacity ledger add this on top.
const jvmOverheadPercent = Math.max(0, envNumber(process.env.MC_DASH_JVM_OVERHEAD_PERCENT, 15));
const jvmOverheadMinMb = Math.max(0, envNumber(process.env.MC_DASH_JVM_OVERHEAD_MIN_MB, 256));

// Refuse starts that don't fit the budget. When off, the ledger is still
// computed and shown in the UI — it just never blocks a start.
const memoryAdmissionEnabled = envBool(process.env.MC_DASH_MEMORY_ADMISSION, true);

// Second, independent gate: however the ledger looks, don't start a server when
// the host has less genuinely-free memory than that server needs, plus this
// floor. Catches memory eaten by things MC Dash doesn't know about.
const hostFreeFloorMb = Math.max(0, envNumber(process.env.MC_DASH_HOST_FREE_FLOOR_MB, 512));

// Whether a server container may use host swap:
//   'off'   — MemorySwap == Memory, so the container cannot swap at all and a
//             server that blows its cap is OOM-killed instead. One dead server
//             beats a thrashing host, which is the whole point of this feature.
//   'limit' — allow swap up to the cap again (2x Memory) but with swappiness 0,
//             so the kernel only reaches for it under genuine pressure.
//   'host'  — don't set anything; inherit the daemon default.
const containerSwapRaw = (process.env.MC_DASH_CONTAINER_SWAP ?? 'off').trim().toLowerCase();
const containerSwapMode: 'off' | 'limit' | 'host' =
  containerSwapRaw === 'limit' || containerSwapRaw === 'host' ? containerSwapRaw : 'off';

// Elastic heap: rewrite the pack's JVM flags so an idle server hands committed
// heap back to the OS instead of sitting on its peak until restart. jvmTuning.ts.
const elasticHeapEnabled = envBool(process.env.MC_DASH_ELASTIC_HEAP, true);
// How long the JVM must go without a GC pause before it runs a reclaiming one.
const elasticHeapIdleSeconds = Math.max(30, envNumber(process.env.MC_DASH_ELASTIC_HEAP_IDLE_SECONDS, 300));

// ---------------------------------------------------------------------------
// Hibernation
//
// Shrinking an idle JVM reclaims some of its heap. Stopping it reclaims all of
// it, plus the CPU and the container overhead — a different order of saving, and
// the only one that fixes a host where four servers exist but one is played on.
// The cost is a cold start, paid by whoever wakes it.
// ---------------------------------------------------------------------------

const hibernationEnabled = envBool(process.env.MC_DASH_HIBERNATE, false);

// Continuous stretch with zero players before a server sleeps. Counted from
// RCON player counts only — see hibernationService for why an unreadable count
// resets the clock rather than counting as empty.
const hibernationIdleMs = Math.max(60, envNumber(process.env.MC_DASH_HIBERNATE_IDLE_MINUTES, 5) * 60) * 1000;

// Hold the sleeping server's port so a join can start it again. Off means a
// hibernated server can only be started from the dashboard, which is a
// legitimate choice for a private server but a bad default for a public one.
const hibernationWakeOnConnect = envBool(process.env.MC_DASH_HIBERNATE_WAKE_ON_CONNECT, true);

// What the client shows in its server list while asleep, and on the disconnect
// screen after a join has triggered the start.
const hibernationMotd = process.env.MC_DASH_HIBERNATE_MOTD || 'Sleeping — join to wake this server up';
const hibernationWakeMessage =
  process.env.MC_DASH_HIBERNATE_WAKE_MESSAGE ||
  'This server was asleep and is starting now.\nGive it about a minute, then reconnect.';

const SESSION_TTL_DAYS = Number(process.env.MC_DASH_SESSION_TTL_DAYS ?? 7);

// Server packs and snapshot archives are uploaded in chunks (see
// services/uploadStaging), so this ceiling is disk, not memory — nothing here
// is ever held in RAM whole. A snapshot of a long-lived server carries its whole
// world and can reach tens of gigabytes, so this is deliberately loose: the
// check that actually protects the host is free space (below), which knows what
// the disk can take. This is only a backstop against an absurd declared size.
const maxUploadMb = Math.max(1, envNumber(process.env.MC_DASH_MAX_UPLOAD_MB, 32768));
// An upload needs room for more than itself: the archive is staged whole, then
// extracted alongside it. Require this multiple of the declared size to be free
// before accepting one, or the floor below, whichever is larger.
const uploadDiskFactor = Math.max(1, envNumber(process.env.MC_DASH_UPLOAD_DISK_FACTOR, 1.5));
// Floor for small uploads, where a multiple of the size would reserve nothing
// worth having.
const uploadDiskMinFreeMb = Math.max(0, envNumber(process.env.MC_DASH_UPLOAD_DISK_MIN_FREE_MB, 2048));
// Smallest slice a request will carry. The point of chunking is to stay under
// whatever the proxy in front allows, and the tightest common ceiling is
// Cloudflare's 100 MB — 8 MB leaves a wide margin and costs ~30 requests for a
// 240 MB pack.
const uploadChunkMb = Math.min(64, Math.max(1, envNumber(process.env.MC_DASH_UPLOAD_CHUNK_MB, 8)));
// Slices grow with the file rather than staying at the floor, because chunks are
// sent one after another: a 10 GB upload at 8 MB is 1280 sequential round trips,
// and on a fast link the waiting costs more than the bytes. 64 MB still sits
// comfortably under the 100 MB ceiling, and caps a retry's wasted work.
const uploadChunkMaxMb = Math.max(uploadChunkMb, Math.min(90, envNumber(process.env.MC_DASH_UPLOAD_CHUNK_MAX_MB, 64)));

// Fail closed. Anyone who gets past the login can upload a server pack and have
// the backend run it through the host's Docker socket, so an unset
// MC_DASH_PASSWORD must stop the boot rather than quietly serve an open API —
// the failure mode of a typo'd env file should be "won't start", not "the
// internet can spawn containers on my host". Opt out only on a trusted LAN.
const allowNoAuth = String(process.env.MC_DASH_ALLOW_NO_AUTH ?? '').toLowerCase() === 'true';
const frontendOrigins = (process.env.MC_DASH_FRONTEND_ORIGIN ?? 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  sqlitePath: process.env.SQLITE_PATH ? path.resolve(process.cwd(), process.env.SQLITE_PATH) : defaultSqlitePath,
  dockerSocketPath: defaultDockerSocketPath,
  dockerHost: process.env.DOCKER_HOST,
  dockerTlsVerify: process.env.DOCKER_TLS_VERIFY,
  dockerApiVersion: process.env.DOCKER_API_VERSION,
  dataRoot,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  uploadDiskFactor,
  uploadDiskMinFreeBytes: uploadDiskMinFreeMb * 1024 * 1024,
  uploadChunkBytes: uploadChunkMb * 1024 * 1024,
  uploadChunkMaxBytes: uploadChunkMaxMb * 1024 * 1024,
  containerUser: resolveContainerUser(),
  javaImage: process.env.JAVA_IMAGE ?? 'eclipse-temurin:17-jre',
  serverPort: Number.isFinite(defaultServerPort) ? defaultServerPort : 25565,
  serverPortMin: Number.isFinite(serverPortMin) ? serverPortMin : 25565,
  serverPortMax: Number.isFinite(serverPortMax) ? serverPortMax : 25565,
  routerEnabled,
  routerDomain,
  routerPort: Number.isFinite(routerPort) ? routerPort : 25565,
  routerTargetHost,
  routerDefaultSubdomain,
  // Auth: when MC_DASH_PASSWORD is set, the API requires a login session.
  authPassword: process.env.MC_DASH_PASSWORD || undefined,
  allowNoAuth,
  sessionSecret: process.env.MC_DASH_SESSION_SECRET || undefined,
  sessionTtlMs: (Number.isFinite(SESSION_TTL_DAYS) ? SESSION_TTL_DAYS : 7) * 24 * 60 * 60 * 1000,
  cookieSecure: String(process.env.MC_DASH_COOKIE_SECURE ?? '').toLowerCase() === 'true',
  frontendOrigins,
  // Behind a reverse proxy / Cloudflare tunnel every request arrives from
  // 127.0.0.1, which would make req.ip useless for the login throttle and the
  // failed-login log. Set to "loopback" (or a hop count) so Express reads
  // X-Forwarded-For instead. Only safe when the port is not directly reachable,
  // otherwise anyone can forge the header — hence off by default.
  trustProxy: process.env.MC_DASH_TRUST_PROXY || undefined,
  // Bind 127.0.0.1 when a tunnel/proxy fronts the API, so the port can't be hit
  // directly and bypass whatever gating sits in front of it.
  bindHost: process.env.MC_DASH_BIND_HOST || '0.0.0.0',
  hibernationEnabled,
  hibernationIdleMs,
  hibernationWakeOnConnect,
  hibernationMotd,
  hibernationWakeMessage,
  memoryReserveMb,
  memoryBurstRatio,
  memoryUseObservedPeaks,
  memoryObservedPeakMarginPercent,
  memoryObservedPeakMinSamples,
  jvmOverheadPercent,
  jvmOverheadMinMb,
  memoryAdmissionEnabled,
  hostFreeFloorMb,
  containerSwapMode,
  elasticHeapEnabled,
  elasticHeapIdleSeconds,
};

// Ensure the data directory exists for SQLite
const sqliteDir = path.dirname(config.sqlitePath);
if (!fs.existsSync(sqliteDir)) {
  fs.mkdirSync(sqliteDir, { recursive: true });
}

// Ensure data root exists for server files
if (!fs.existsSync(config.dataRoot)) {
  fs.mkdirSync(config.dataRoot, { recursive: true });
}
