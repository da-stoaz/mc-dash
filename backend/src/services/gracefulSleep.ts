import type { ServerRecord } from '../types';
import { dockerService } from './dockerService';
import { runServerRcon } from './rconService';

type Dependencies = {
  command: typeof runServerRcon;
  waitForExit: (server: ServerRecord, timeoutMs: number) => Promise<boolean>;
};

/** Automatic memory management must never escalate a failed save into SIGKILL. */
export async function gracefulSleep(
  server: ServerRecord,
  beforeStop: () => boolean | Promise<boolean>,
  deps: Dependencies = { command: runServerRcon, waitForExit: (s, ms) => dockerService.waitForExit(s, ms, { requireClean: true }) },
): Promise<void> {
  const saved = await deps.command(server, ['save-all flush'], { timeoutMs: 30_000 });
  // A response alone is not success: RCON also returns syntax and disk errors.
  // Unknown/modded responses fail closed until their save acknowledgement is supported.
  if (!saved?.some(output => /\bSaved the (?:game|world)\b/i.test(output))) {
    throw new Error('World save was not confirmed. Automatic shutdown was cancelled; no forced stop was sent.');
  }
  if (!await beforeStop()) throw new Error('Server changed during saving. Automatic shutdown was cancelled.');
  // The stop command may close RCON before replying. Confirm the process exit instead.
  await deps.command(server, ['stop']).catch(() => null);
  if (!await deps.waitForExit(server, 60_000)) {
    throw new Error('A clean shutdown was not confirmed. No forced stop was sent; inspect its console.');
  }
}
