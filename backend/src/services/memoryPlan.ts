import { config } from '../config';
import { ResourceConfig } from '../types';

// ---------------------------------------------------------------------------
// Translating a server's RAM settings into cgroup numbers.
//
// Kept separate from both dockerService (which applies these) and
// hostCapacityService (which adds them up) so the two can never disagree about
// what a server costs — an admission check that budgets one number while the
// container is created with another is worse than no check at all.
// ---------------------------------------------------------------------------

/**
 * What a JVM needs beyond its heap: metaspace, code cache, thread stacks, GC
 * bookkeeping, direct byte buffers, and the JIT's own allocations. All of it
 * sits inside the cgroup and outside -Xmx, so a container capped at exactly
 * -Xmx is killed by the kernel just as the heap fills — a crash that looks
 * random and always lands under load.
 */
export function jvmOverheadMb(heapMb: number): number {
  return Math.round(Math.max((heapMb * config.jvmOverheadPercent) / 100, config.jvmOverheadMinMb));
}

export type ContainerMemoryPlan = {
  /** Hard cgroup ceiling: heap plus overhead. */
  capMb: number;
  /**
   * Soft cgroup limit. Under host memory pressure the kernel reclaims from
   * containers sitting above their reservation before it touches ones below,
   * so an idle server that has handed heap back is preferred over a busy one.
   */
  floorMb: number;
};

/**
 * null when the server has no configured ceiling — old records from before
 * resources were required. Those get no limits rather than a guessed one.
 */
export function containerMemoryPlan(resources: ResourceConfig | undefined): ContainerMemoryPlan | null {
  const maxRamMb = Number(resources?.maxRamMb);
  if (!Number.isFinite(maxRamMb) || maxRamMb <= 0) return null;

  const overheadMb = jvmOverheadMb(maxRamMb);
  const rawMin = Number(resources?.minRamMb);
  const minRamMb = Number.isFinite(rawMin) && rawMin > 0 ? Math.min(rawMin, maxRamMb) : Math.min(512, maxRamMb);

  return { capMb: maxRamMb + overheadMb, floorMb: minRamMb + overheadMb };
}
