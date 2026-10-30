import { db } from '../db';

db.exec(`CREATE TABLE IF NOT EXISTS memory_recovery (
  serverId TEXT PRIMARY KEY, untilMs INTEGER NOT NULL, demandMb REAL NOT NULL, durationMs INTEGER NOT NULL DEFAULT 0
)`);
// Old observations included file cache and cannot be used as process demand.
const columns = db.prepare('PRAGMA table_info(memory_recovery)').all() as { name: string }[];
if (!columns.some(column => column.name === 'accountingVersion')) {
  db.exec('ALTER TABLE memory_recovery ADD COLUMN accountingVersion INTEGER NOT NULL DEFAULT 0');
}
export function recordPressureSleep(id:string, demandMb:number, now=Date.now(), durationMs=0) {
  db.prepare(`INSERT INTO memory_recovery (serverId,untilMs,demandMb,durationMs,accountingVersion) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(serverId) DO UPDATE SET untilMs=excluded.untilMs,
    demandMb=excluded.demandMb, durationMs=MAX(durationMs,excluded.durationMs), accountingVersion=1`)
    .run(id,now+300_000,Math.max(0,demandMb),Math.max(0,durationMs));
}
export function pressureRestartDemand(id:string, capMb:number, now=Date.now()):number {
  const row=db.prepare('SELECT * FROM memory_recovery WHERE serverId=? AND accountingVersion=1').get(id) as {untilMs:number; demandMb:number}|undefined;
  // Re-evaluate actual capacity immediately. A timer alone must not prevent a
  // player or operator from recovering a server after memory has been freed.
  if (!row || now >= row.untilMs) return 0;
  return Math.min(capMb,row.demandMb);
}
export function shutdownHorizonMs():number {
  const row=db.prepare('SELECT MAX(durationMs) AS duration FROM memory_recovery').get() as {duration:number|null};
  // Warning + at least 95 seconds for save/stop + polling margin.
  return 60_000+Math.max(95_000,row.duration ?? 0)+30_000;
}

/** Reconstruct recent demand during a boot after a backend restart. */
export function observedPressureDemand(id:string,capMb:number):number {
  return pressureRestartDemand(id,capMb);
}
