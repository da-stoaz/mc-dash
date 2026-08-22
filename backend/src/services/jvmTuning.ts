import { config } from '../config';

// ---------------------------------------------------------------------------
// Elastic heap
//
// The reason three "idle" 8 GB servers still fill a 12 GB box is that a JVM
// never gives heap back on its own. Two things conspire:
//
//   1. Aikar's flags — which practically every modpack start script ships —
//      set -Xms equal to -Xmx *and* -XX:+AlwaysPreTouch. AlwaysPreTouch walks
//      the whole initial heap at startup and writes a zero to every page, so
//      the full -Xmx is committed and resident before a single chunk loads. An
//      "idle" server is then indistinguishable from a saturated one, and three
//      of them are 24 GB of anonymous pages the kernel can only push to swap.
//
//   2. Even without pre-touch, G1 only resizes the heap at a full GC or during
//      a concurrent cycle, and it is built to avoid both. A server that spiked
//      to 6 GB during chunk generation keeps those 6 GB committed for the rest
//      of its uptime, because nothing ever asks it to shrink. (JEP 346 exists
//      precisely for this; it is opt-in and off by default.)
//
// So we rewrite the flags we control:
//   - -Xms is the *floor*, taken from the server's minRamMb. The heap never
//     shrinks below it, which is what makes minRamMb the meaningful "idle
//     footprint" dial rather than a number nobody reads.
//   - AlwaysPreTouch is forced off, so committing follows real demand.
//   - G1PeriodicGCInterval (JEP 346, JDK 12+) makes G1 run a reclaiming GC
//     after a stretch with no GC pause at all — which only happens when the
//     server is genuinely idle. Under load, ordinary GCs keep resetting the
//     timer and it never fires, so this costs a busy server nothing.
//   - G1PeriodicGCInvokesConcurrent stays *on*. The reclaiming GC could also be
//     a full GC, which sounds better — until you measure it. On a 1.5 GB live
//     set a periodic full GC is a 365 ms stop-the-world pause, and it fires on
//     a timer whenever ordinary GCs have been quiet for a while. That is not
//     "free because the server is idle": a lightly-played server goes minutes
//     between young GCs while someone is very much standing in it, so the
//     timer expires mid-session and drops 7+ ticks. A concurrent cycle
//     measured the same reclaim (both ended at -Xms) with no such pause, so
//     the full GC bought nothing and cost a visible stutter.
//   - Min/MaxHeapFreeRatio are tightened from G1's 40/70 defaults so every
//     resize that does happen gives more back.
//
// All of it is prefixed with -XX:+IgnoreUnrecognizedVMOptions so a pack pinned
// to an older JVM skips what it doesn't know instead of refusing to boot. That
// also makes a typo'd flag in the pack's own args non-fatal, which is a change
// in kind — but "boots with one flag ignored" beats today's "exits 1 with a
// message nobody reads".
// ---------------------------------------------------------------------------

export type HeapPlan = {
  /** -Xms, in MB. The floor the heap never shrinks below. */
  minMb: number;
  /** -Xmx, in MB. */
  maxMb: number;
};

export type ElasticHeapOptions = {
  /** Quiet stretch, in seconds, before the JVM runs a reclaiming GC. */
  idleSeconds: number;
  /**
   * Skip the periodic GC when the host's load average is above this. 0 (the
   * default) disables the check — safe, because the periodic GC can only fire
   * when no other GC ran for the whole interval, which already means the
   * server is doing nothing.
   */
  loadThreshold?: number;
};

// Flags we own outright. Any of these already present in a pack's args is
// dropped before ours are appended, so merging is idempotent and our value is
// the one that survives.
const MANAGED_PREFIXES = [
  '-Xms',
  '-Xmx',
  '-XX:+AlwaysPreTouch',
  '-XX:-AlwaysPreTouch',
  '-XX:+IgnoreUnrecognizedVMOptions',
  '-XX:-IgnoreUnrecognizedVMOptions',
  '-XX:G1PeriodicGCInterval=',
  '-XX:+G1PeriodicGCInvokesConcurrent',
  '-XX:-G1PeriodicGCInvokesConcurrent',
  '-XX:G1PeriodicGCSystemLoadThreshold=',
  '-XX:MinHeapFreeRatio=',
  '-XX:MaxHeapFreeRatio=',
];

export function isManagedFlag(token: string): boolean {
  return MANAGED_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * The elastic-heap flags on their own, without -Xms/-Xmx. Used both when
 * rewriting a pack's args and as the container-wide JAVA_TOOL_OPTIONS default
 * for start scripts we can't safely rewrite.
 */
export function elasticHeapFlags(opts: ElasticHeapOptions): string[] {
  const intervalMs = Math.max(1000, Math.round(opts.idleSeconds * 1000));
  const loadThreshold = Math.max(0, Math.round(opts.loadThreshold ?? 0));
  return [
    // Must come first: it governs how the JVM treats every -XX flag after it.
    '-XX:+IgnoreUnrecognizedVMOptions',
    '-XX:-AlwaysPreTouch',
    `-XX:G1PeriodicGCInterval=${intervalMs}`,
    // Concurrent, never a full GC — see the header. This one flag is the
    // difference between a reclaim nobody notices and a periodic freeze.
    '-XX:+G1PeriodicGCInvokesConcurrent',
    `-XX:G1PeriodicGCSystemLoadThreshold=${loadThreshold}`,
    '-XX:MinHeapFreeRatio=10',
    '-XX:MaxHeapFreeRatio=30',
  ];
}

/**
 * variables.txt stores the whole argument list as one quoted shell value —
 * JAVA_ARGS="-Xmx8192M -Xms2048M" — and the start script then expands it
 * unquoted so the shell word-splits it. Those outer quotes are a container, not
 * a single argument, so peel them before tokenizing.
 *
 * Only a genuinely matching outer pair is stripped: quotes that appear inside
 * (an -javaagent path with a space, say) are left for the tokenizer to honour.
 */
function stripWrappingQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  if (first !== '"' && first !== "'") return trimmed;
  if (trimmed[trimmed.length - 1] !== first) return trimmed;
  const inner = trimmed.slice(1, -1);
  return inner.includes(first) ? trimmed : inner;
}

/**
 * Split a JVM argument string into tokens, honouring the single and double
 * quotes that shell-sourced files like ServerPackCreator's variables.txt use.
 */
export function tokenizeJvmArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of stripWrappingQuotes(raw)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens.filter((token) => token.length > 0);
}

/**
 * Take whatever JVM args a pack already carries, drop the ones we manage, and
 * append our heap plan plus (optionally) the elastic-heap flags.
 *
 * Everything else the pack author chose — GC region sizes, Netty tuning, agent
 * paths — is preserved in its original order. We are correcting the memory
 * profile, not replacing someone's tuning.
 */
export function mergeJvmArgs(
  existing: string[],
  heap: HeapPlan,
  opts: ElasticHeapOptions & { elastic: boolean }
): string[] {
  const kept = existing.filter((token) => !isManagedFlag(token));
  const managed = opts.elastic ? elasticHeapFlags(opts) : [];
  // -Xms/-Xmx go last so they win over anything the kept args imply.
  return [...managed, ...kept, `-Xms${Math.round(heap.minMb)}M`, `-Xmx${Math.round(heap.maxMb)}M`];
}

/**
 * A sane heap plan from a server's configured resources.
 *
 * A missing or oversized minRamMb is clamped rather than rejected: -Xms above
 * -Xmx makes the JVM refuse to start, and "the server won't boot" is a bad way
 * to learn that two numbers in a form disagree.
 */
export function heapPlan(resources: { minRamMb?: number; maxRamMb?: number }): HeapPlan | null {
  const maxMb = Number(resources.maxRamMb);
  if (!Number.isFinite(maxMb) || maxMb <= 0) return null;
  const rawMin = Number(resources.minRamMb);
  const minMb = Number.isFinite(rawMin) && rawMin > 0 ? Math.min(rawMin, maxMb) : Math.min(512, maxMb);
  return { minMb, maxMb };
}

/**
 * The container-wide JAVA_TOOL_OPTIONS value.
 *
 * Pack start scripts are arbitrary shell we don't parse, so some build their
 * own `java ...` line that our variables.txt / user_jvm_args.txt rewrites never
 * touch. The JVM reads JAVA_TOOL_OPTIONS before the command line, so this gives
 * those scripts elastic-heap behaviour by default while still letting an
 * explicit flag on their command line win. Deliberately carries no -Xms/-Xmx
 * and no collector choice: overriding a script's own heap sizing from the
 * environment would be surprising, and forcing a collector could collide with a
 * pack that picked ZGC or Shenandoah.
 */
export function javaToolOptions(): string | undefined {
  if (!config.elasticHeapEnabled) return undefined;
  return elasticHeapFlags({ idleSeconds: config.elasticHeapIdleSeconds }).join(' ');
}
