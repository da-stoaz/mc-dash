/** Conservative trend estimate: require three increasing samples over 20 seconds.
 * Drops, stale gaps, and changed limits reset the trend (including GC/restarts).
 */
export class MemoryForecast {
  private samples = new Map<string, {at:number; used:number; limit:number}[]>();
  approaching(key:string, used:number, limit:number, now:number, horizonMs:number): boolean {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit<=0) return false;
    let samples=this.samples.get(key) ?? [];
    const last=samples[samples.length-1];
    if (last && (now-last.at>30_000 || used<last.used || limit!==last.limit)) samples=[];
    if (!last || now-last.at>=5_000 || samples.length===0) samples.push({at:now,used,limit});
    samples=samples.filter(s=>now-s.at<=60_000);
    this.samples.set(key,samples);
    // Normal heap expansion during startup must not become a shutdown forecast
    // while most of the budget is still available.
    if (used < limit * 0.85 || samples.length<3 || now-samples[0].at<20_000) return false;
    if(samples.some((sample,i)=>i>0 && sample.used<=samples[i-1].used)) return false;
    const growth=(used-samples[0].used)/(now-samples[0].at);
    return growth>0 && used+growth*horizonMs>=limit;
  }
  retain(keys:Set<string>) { for(const key of this.samples.keys()) if(!keys.has(key)) this.samples.delete(key); }
}
