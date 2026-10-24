import { db } from '../db';
import type { ServerRecord } from '../types';
import { containerMemoryPlan } from './memoryPlan';

db.exec(`CREATE TABLE IF NOT EXISTS boot_memory (
  serverId TEXT NOT NULL, profile TEXT NOT NULL, peakMb REAL NOT NULL,
  PRIMARY KEY(serverId, profile)
)`);
function profile(server:ServerRecord):string {
  return JSON.stringify([server.resources?.minRamMb,server.resources?.maxRamMb,
    server.effectiveJavaImage ?? server.javaImage,server.serverPackUrl]);
}
/** Include the first two minutes after process start even if readiness came early.
 * A slow boot remains observable for as long as it is starting/restarting.
 */
export function observeBootMemory(server:ServerRecord, usedBytes:number, uptimeSeconds:number|null):void {
  if (!Number.isFinite(usedBytes) || usedBytes<=0) return;
  const booting=['starting','restarting'].includes(server.status);
  if(!booting && (uptimeSeconds===null || uptimeSeconds<0 || uptimeSeconds>120)) return;
  db.prepare(`INSERT INTO boot_memory VALUES (?, ?, ?)
    ON CONFLICT(serverId,profile) DO UPDATE SET peakMb=MAX(peakMb,excluded.peakMb)`)
    .run(server.id,profile(server),usedBytes/1024**2);
}
export function bootMemoryDemand(server:ServerRecord):number {
  const plan=containerMemoryPlan(server.resources);
  if(!plan) return 0;
  const row=db.prepare('SELECT peakMb FROM boot_memory WHERE serverId=? AND profile=?')
    .get(server.id,profile(server)) as {peakMb:number}|undefined;
  // Observations are a forecast, not a reservation of the configured maximum.
  return Math.max(plan.floorMb,Math.min(plan.capMb,Math.ceil((row?.peakMb ?? 0)*1.10)));
}
