import type { ServerRecord } from '../types';
import { heapPlan } from './jvmTuning';

export type JvmMemoryInspection = {
  status:'verified'|'mismatch'|'unverified';
  initialHeapMb:number|null;
  maximumHeapMb:number|null;
  containerLimitMb:number|null;
  checkedAt:number;
  reason:string;
};
export function interpretJvmMemory(flags:string, server:ServerRecord, containerBytes:number, checkedAt=Date.now()):JvmMemoryInspection {
  const read=(name:string)=>{
    const matches=[...flags.matchAll(new RegExp(`(?:^|\\s)-XX:${name}=(\\d+)(?=\\s|$)`,'g'))];
    if(matches.length!==1) return null;
    const value=Number(matches[0][1]);
    return Number.isSafeInteger(value) && value>0 ? value/1024**2 : null;
  };
  const initialHeapMb=read('InitialHeapSize'), maximumHeapMb=read('MaxHeapSize');
  const containerLimitMb=Number.isFinite(containerBytes)&&containerBytes>0?containerBytes/1024**2:null;
  const base={initialHeapMb,maximumHeapMb,containerLimitMb,checkedAt};
  if(initialHeapMb===null || maximumHeapMb===null || initialHeapMb>maximumHeapMb)
    return {...base,status:'unverified',reason:'The JVM did not provide unambiguous initial and maximum heap sizes.'};
  const desired=server.resources && heapPlan(server.resources);
  // HotSpot may align heap sizes; tolerate up to 2% or 8 MiB.
  const differs=(actual:number,expected:number)=>Math.abs(actual-expected)>Math.max(8,expected*0.02);
  if(!desired || !containerLimitMb) return {...base,status:'unverified',reason:'Configured heap or effective container limit is unavailable.'};
  if(maximumHeapMb>=containerLimitMb) return {...base,status:'mismatch',reason:'The JVM maximum leaves no memory outside its heap within the container limit.'};
  if(differs(initialHeapMb,desired.minMb)||differs(maximumHeapMb,desired.maxMb))
    return {...base,status:'mismatch',reason:server.restartRequired?'Running heap settings differ from saved settings; a restart is pending.':'The running JVM heap differs from the configured heap. Check the pack launch arguments.'};
  if (containerLimitMb !== server.resources.maxRamMb)
    return {...base,status:'mismatch',reason:server.restartRequired?'Running container limit differs from saved settings; a restart is pending.':'The running container limit differs from the configured RAM limit.'};
  return {...base,status:'verified',reason:'Running JVM heap sizes match the configured settings. This does not verify world-save behavior or prevent leaks.'};
}

// Static command only: no server-controlled paths/arguments are interpolated.
// Select exactly one Java executable from /proc, avoiding jcmd's own JVM.
// Use that JVM's JDK and the container's configured user. Missing tools fail closed.
export const JVM_FLAGS_COMMAND = `command -v timeout >/dev/null 2>&1 || exit 40
count=0
for proc in /proc/[0-9]*; do
  exe=$(readlink "$proc/exe" 2>/dev/null) || continue
  case "$exe" in */java) count=$((count+1)); pid=$(basename "$proc"); java_bin=$exe;; esac
done
[ "$count" = 1 ] || exit 41
jcmd_path="$(dirname "$java_bin")/jcmd"
if [ -x "$jcmd_path" ]; then
  exec timeout -s KILL 5 "$jcmd_path" "$pid" VM.flags
fi
[ -n "$1" ] || exit 42
[ -x "$1" ] || exit 126
exec timeout -s KILL 5 "$1" "$pid" jcmd VM.flags`;

export function inspectionFailure(code: number | null): string {
  switch (code) {
    case 40: return 'The Java image has no timeout utility for a bounded inspection.';
    case 41: return 'Expected exactly one running Java process. Retry when startup has finished.';
    case 42: return 'This JRE has no jcmd, and the MC Dash diagnostic helper is unavailable.';
    case 124: case 137: return 'The JVM did not answer within five seconds. Attach may be disabled or the JVM is busy.';
    case 126: case 127: return 'The Java image cannot execute the diagnostic helper (architecture or executable permissions).';
    default: return 'The JVM rejected diagnostic attach. Check attach permissions or whether this runtime supports HotSpot diagnostics.';
  }
}
