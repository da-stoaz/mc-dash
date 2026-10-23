import { db } from '../db';
import { UserFacingError } from '../apiErrors';

db.exec(`CREATE TABLE IF NOT EXISTS memory_recovery (
  serverId TEXT PRIMARY KEY, untilMs INTEGER NOT NULL, demandMb REAL NOT NULL, durationMs INTEGER NOT NULL DEFAULT 0
)`);
export function recordPressureSleep(id:string, demandMb:number, now=Date.now(), durationMs=0) {
  db.prepare(`INSERT INTO memory_recovery VALUES (?, ?, ?, ?)
    ON CONFLICT(serverId) DO UPDATE SET untilMs=excluded.untilMs,
    demandMb=MAX(demandMb,excluded.demandMb), durationMs=MAX(durationMs,excluded.durationMs)`)
    .run(id,now+300_000,Math.max(0,demandMb),Math.max(0,durationMs));
}
export function pressureRestartDemand(id:string, capMb:number, now=Date.now()):number {
  const row=db.prepare('SELECT * FROM memory_recovery WHERE serverId=?').get(id) as {untilMs:number; demandMb:number}|undefined;
  if (!row) return 0;
  if(now<row.untilMs) throw new UserFacingError({error:'Server is cooling down after RAM pressure',code:'MEMORY_RECOVERY_COOLDOWN',status:409,
    reason:`Try again in ${Math.ceil((row.untilMs-now)/1000)} seconds. The previous memory demand must also fit before restarting.`});
  return Math.min(capMb,row.demandMb);
}
export function shutdownHorizonMs():number {
  const row=db.prepare('SELECT MAX(durationMs) AS duration FROM memory_recovery').get() as {duration:number|null};
  // Warning + at least 95 seconds for save/stop + polling margin.
  return 60_000+Math.max(95_000,row.duration ?? 0)+30_000;
}

/** Restore demand during a boot without applying the pre-start cooldown again. */
export function observedPressureDemand(id:string,capMb:number):number {
  const row=db.prepare('SELECT demandMb FROM memory_recovery WHERE serverId=?').get(id) as {demandMb:number}|undefined;
  return Math.min(capMb,row?.demandMb ?? 0);
}
