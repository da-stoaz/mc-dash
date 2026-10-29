import type Database from 'better-sqlite3';
import { jvmOverheadMb } from './memoryPlan';

/** Preserve existing Docker ceilings when changing maxRamMb from heap to total
 * RAM. Do not tighten a running container or silently increase its JVM heap.
 */
export function migrateMemoryLimits(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  db.transaction(() => {
    const name = 'total-container-ram-v1';
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) return;
    const hasBootMemory = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='boot_memory'").get();
    const rows = db.prepare('SELECT id, resources FROM servers').all() as {id: string; resources: string}[];
    for (const row of rows) {
      const resources = JSON.parse(row.resources);
      const oldMax = Number(resources.maxRamMb);
      if (!Number.isFinite(oldMax) || oldMax <= 0) continue;
      resources.maxRamMb = oldMax + jvmOverheadMb(oldMax);
      db.prepare('UPDATE servers SET resources=? WHERE id=?').run(JSON.stringify(resources), row.id);
      // Keep learned startup demand attached to the equivalent configuration.
      if (hasBootMemory) {
        const observations = db.prepare('SELECT profile, peakMb FROM boot_memory WHERE serverId=?').all(row.id) as {profile: string; peakMb: number}[];
        for (const observation of observations) {
          const profile = JSON.parse(observation.profile);
          if (profile[1] !== oldMax) continue;
          profile[1] = resources.maxRamMb;
          db.prepare(`INSERT INTO boot_memory VALUES (?, ?, ?)
            ON CONFLICT(serverId,profile) DO UPDATE SET peakMb=MAX(peakMb,excluded.peakMb)`)
            .run(row.id, JSON.stringify(profile), observation.peakMb);
          db.prepare('DELETE FROM boot_memory WHERE serverId=? AND profile=?').run(row.id, observation.profile);
        }
      }
    }
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
  })();
}
