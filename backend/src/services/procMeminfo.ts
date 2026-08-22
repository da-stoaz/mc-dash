import fs from 'fs';

// ---------------------------------------------------------------------------
// /proc/meminfo, isolated on purpose.
//
// This is the one piece of capacity accounting that *only* runs in production.
// On a Docker Desktop dev box the daemon lives in a VM whose memory has nothing
// to do with the host's, so readHostMemory falls back to the daemon's own total
// and the live-pressure gate is skipped entirely — meaning this code path and
// the HOST_MEMORY_LOW check it feeds are first exercised on the real server.
//
// It therefore lives in its own module with no dependencies beyond `fs`, so it
// can be imported and run inside a throwaway Linux container against a real
// /proc/meminfo, rather than being trusted on the strength of a regex.
// ---------------------------------------------------------------------------

export type ProcMemory = {
  totalMb: number;
  /** MemAvailable where the kernel provides it, else a reconstruction. */
  availableMb: number;
  /** False when MemAvailable was absent and availableMb is an approximation. */
  availableExact: boolean;
  swapTotalMb: number;
  swapUsedMb: number;
};

const KB_PER_MB = 1024;

export function parseMeminfo(raw: string): Record<string, number> | null {
  const values: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    // Every size line is "Key:<spaces><number> kB". A few entries (HugePages_*)
    // have no unit and are deliberately not matched — we want none of them.
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  return Object.keys(values).length ? values : null;
}

export function toProcMemory(values: Record<string, number>): ProcMemory | null {
  if (!values.MemTotal) return null;

  const swapTotalMb = Math.round((values.SwapTotal ?? 0) / KB_PER_MB);
  const swapFreeMb = Math.round((values.SwapFree ?? 0) / KB_PER_MB);
  const hasAvailable = typeof values.MemAvailable === 'number';

  return {
    totalMb: Math.round(values.MemTotal / KB_PER_MB),
    // Kernels before 3.14 have no MemAvailable. MemFree alone understates
    // badly once the page cache warms, and gating starts on it would refuse
    // everything, so reconstruct from the obviously reclaimable parts instead.
    availableMb: Math.round(
      (hasAvailable ? values.MemAvailable : (values.MemFree ?? 0) + (values.Cached ?? 0) + (values.Buffers ?? 0)) /
        KB_PER_MB
    ),
    availableExact: hasAvailable,
    swapTotalMb,
    swapUsedMb: Math.max(0, swapTotalMb - swapFreeMb),
  };
}

/** Reads the real file; the injection point exists so tests can supply one. */
export function readProcMemory(read: () => string = () => fs.readFileSync('/proc/meminfo', 'utf8')): ProcMemory | null {
  try {
    const values = parseMeminfo(read());
    return values ? toProcMemory(values) : null;
  } catch {
    return null;
  }
}
