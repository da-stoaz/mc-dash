import { db } from './db';

// ---------------------------------------------------------------------------
// Tiered time-series rollups (RRD-style).
//
// We never persist raw 2s/5s samples. Instead each metric is consolidated into
// fixed-resolution buckets, and each tier is retained only for the window the
// matching UI tab needs. This keeps storage bounded at ~750 rows/server forever
// regardless of uptime, while every tab renders a bounded point count.
//
//   resolution (bucket)  | window kept | UI tab | ~points
//   ---------------------+-------------+--------+--------
//   30s                  | 1h          | 1h     | 120
//   300s (5m)            | 24h         | 1d     | 288
//   1800s (30m)          | 7d          | 7d     | 336
//
// Per bucket we store min/avg/max for CPU and memory (the primary graphs) and
// avg/max for network/disk rates (the min of a rate is almost always ~0 and
// carries little signal). All aggregates are exactly composable across tiers:
// coarse buckets are rebuilt from finer ones with a sample-weighted mean for
// avg, MAX for max and MIN for min.
// ---------------------------------------------------------------------------

export const FINE_RESOLUTION = 30;

export type MetricRange = '1h' | '1d' | '7d';

// range -> resolution (bucket size, seconds) and how long that tier is retained.
const TIERS: Record<MetricRange, { resolution: number; windowSeconds: number }> = {
  '1h': { resolution: 30, windowSeconds: 3600 },
  '1d': { resolution: 300, windowSeconds: 86400 },
  '7d': { resolution: 1800, windowSeconds: 604800 },
};

// Rollup chain: build each coarse tier from the next finer one.
const ROLLUP_CHAIN: { fine: number; coarse: number }[] = [
  { fine: 30, coarse: 300 },
  { fine: 300, coarse: 1800 },
];

db.prepare(
  `CREATE TABLE IF NOT EXISTS metric_rollups (
    serverId    TEXT    NOT NULL,
    resolution  INTEGER NOT NULL,
    bucketStart INTEGER NOT NULL,
    cpuMin  REAL NOT NULL,
    cpuAvg  REAL NOT NULL,
    cpuMax  REAL NOT NULL,
    memMin  REAL NOT NULL,
    memAvg  REAL NOT NULL,
    memMax  REAL NOT NULL,
    netRxAvg  REAL NOT NULL,
    netRxMax  REAL NOT NULL,
    netTxAvg  REAL NOT NULL,
    netTxMax  REAL NOT NULL,
    diskRAvg  REAL NOT NULL,
    diskRMax  REAL NOT NULL,
    diskWAvg  REAL NOT NULL,
    diskWMax  REAL NOT NULL,
    samples   INTEGER NOT NULL,
    PRIMARY KEY (serverId, resolution, bucketStart)
  )`
).run();

export type MetricBucket = {
  serverId: string;
  bucketStart: number;
  cpuMin: number;
  cpuAvg: number;
  cpuMax: number;
  memMin: number;
  memAvg: number;
  memMax: number;
  netRxAvg: number;
  netRxMax: number;
  netTxAvg: number;
  netTxMax: number;
  diskRAvg: number;
  diskRMax: number;
  diskWAvg: number;
  diskWMax: number;
  samples: number;
};

export type MetricPoint = MetricBucket & { t: number };

const COLUMNS =
  'cpuMin, cpuAvg, cpuMax, memMin, memAvg, memMax, netRxAvg, netRxMax, netTxAvg, netTxMax, diskRAvg, diskRMax, diskWAvg, diskWMax, samples';

const insertBucketStmt = db.prepare(
  `INSERT INTO metric_rollups (serverId, resolution, bucketStart, ${COLUMNS})
   VALUES (@serverId, @resolution, @bucketStart, @cpuMin, @cpuAvg, @cpuMax, @memMin, @memAvg, @memMax,
           @netRxAvg, @netRxMax, @netTxAvg, @netTxMax, @diskRAvg, @diskRMax, @diskWAvg, @diskWMax, @samples)
   ON CONFLICT(serverId, resolution, bucketStart) DO UPDATE SET
     cpuMin = excluded.cpuMin, cpuAvg = excluded.cpuAvg, cpuMax = excluded.cpuMax,
     memMin = excluded.memMin, memAvg = excluded.memAvg, memMax = excluded.memMax,
     netRxAvg = excluded.netRxAvg, netRxMax = excluded.netRxMax,
     netTxAvg = excluded.netTxAvg, netTxMax = excluded.netTxMax,
     diskRAvg = excluded.diskRAvg, diskRMax = excluded.diskRMax,
     diskWAvg = excluded.diskWAvg, diskWMax = excluded.diskWMax,
     samples = excluded.samples`
);

// Rebuild one coarse bucket from all finer buckets that fall inside it. avg is
// sample-weighted so buckets with fewer samples don't skew the mean.
const rollupStmt = db.prepare(
  `INSERT INTO metric_rollups (serverId, resolution, bucketStart, ${COLUMNS})
   SELECT @serverId, @coarse, @bucketStart,
     MIN(cpuMin), SUM(cpuAvg * samples) / SUM(samples), MAX(cpuMax),
     MIN(memMin), SUM(memAvg * samples) / SUM(samples), MAX(memMax),
     SUM(netRxAvg * samples) / SUM(samples), MAX(netRxMax),
     SUM(netTxAvg * samples) / SUM(samples), MAX(netTxMax),
     SUM(diskRAvg * samples) / SUM(samples), MAX(diskRMax),
     SUM(diskWAvg * samples) / SUM(samples), MAX(diskWMax),
     SUM(samples)
   FROM metric_rollups
   WHERE serverId = @serverId AND resolution = @fine
     AND bucketStart >= @bucketStart AND bucketStart < @bucketStart + @coarse
   HAVING SUM(samples) > 0
   ON CONFLICT(serverId, resolution, bucketStart) DO UPDATE SET
     cpuMin = excluded.cpuMin, cpuAvg = excluded.cpuAvg, cpuMax = excluded.cpuMax,
     memMin = excluded.memMin, memAvg = excluded.memAvg, memMax = excluded.memMax,
     netRxAvg = excluded.netRxAvg, netRxMax = excluded.netRxMax,
     netTxAvg = excluded.netTxAvg, netTxMax = excluded.netTxMax,
     diskRAvg = excluded.diskRAvg, diskRMax = excluded.diskRMax,
     diskWAvg = excluded.diskWAvg, diskWMax = excluded.diskWMax,
     samples = excluded.samples`
);

const queryStmt = db.prepare(
  `SELECT bucketStart, ${COLUMNS} FROM metric_rollups
   WHERE serverId = ? AND resolution = ? AND bucketStart >= ?
   ORDER BY bucketStart ASC`
);

const pruneStmt = db.prepare(
  `DELETE FROM metric_rollups WHERE resolution = ? AND bucketStart < ?`
);

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

class MetricsStore {
  // Persist a finest-tier (30s) bucket, then cascade the rollups upward.
  writeFineBucket(bucket: MetricBucket) {
    const write = db.transaction((b: MetricBucket) => {
      insertBucketStmt.run({ ...b, resolution: FINE_RESOLUTION });
      for (const { fine, coarse } of ROLLUP_CHAIN) {
        const bucketStart = Math.floor(b.bucketStart / coarse) * coarse;
        rollupStmt.run({ serverId: b.serverId, fine, coarse, bucketStart });
      }
    });
    write(bucket);
  }

  query(serverId: string, range: MetricRange): MetricPoint[] {
    const { resolution, windowSeconds } = TIERS[range];
    const since = nowSeconds() - windowSeconds;
    const rows = queryStmt.all(serverId, resolution, since) as (Omit<MetricBucket, 'serverId'> & {
      bucketStart: number;
    })[];
    return rows.map((row) => ({ ...row, serverId, t: row.bucketStart * 1000 }));
  }

  resolutionFor(range: MetricRange) {
    return TIERS[range].resolution;
  }

  // Drop rows past each tier's retention window. Cheap; safe to call often.
  prune() {
    const now = nowSeconds();
    const prune = db.transaction(() => {
      for (const { resolution, windowSeconds } of Object.values(TIERS)) {
        pruneStmt.run(resolution, now - windowSeconds);
      }
    });
    prune();
  }
}

export const metricsStore = new MetricsStore();
