// SPDX-License-Identifier: AGPL-3.0-only

import type { ServerRecord } from '../types';
import { logger } from '../logger';
import { dockerService } from './dockerService';
import { runServerRcon } from './rconService';

// What `save-all flush` prints once every dimension is on disk (1.13+ "game",
// older versions "world"). Any other answer — an error, a modded message, no
// answer — is not treated as a confirmed save.
export const WORLD_SAVED = /\bSaved the (?:game|world)\b/i;

// A large modded world can take well over a minute to flush.
const SAVE_TIMEOUT_MS = 120_000;
// How long Minecraft gets to finish its own shutdown (which saves again) after
// `stop`, when we can watch its JVM.
const SHUTDOWN_TIMEOUT_MS = 180_000;
// Without a process list we can only watch the container, and a looping pack
// script never lets it exit; don't hold the request for the full window then.
const CONTAINER_ONLY_TIMEOUT_MS = 60_000;
// SIGTERM grace when RCON is unavailable. The generated start.sh execs Java,
// so the JVM receives it and saves; a pack script running Java as a child
// ignores it and is killed when this runs out.
const NO_RCON_GRACE_SEC = 60;
const POLL_MS = 1000;

export type StopOutcome = {
  /** `save-all flush` acknowledged that the world is on disk. */
  saveConfirmed: boolean;
  /** The JVM that was running finished shutting down on its own. */
  jvmExited: boolean;
  /** Docker had to kill a JVM that had not finished shutting down. */
  killedRunningJvm: boolean;
};

type Dependencies = {
  rcon: typeof runServerRcon;
  runState: (server: ServerRecord) => Promise<{ running: boolean; exitCode: number | null }>;
  javaPids: (server: ServerRecord) => Promise<number[] | null>;
  hardStop: (server: ServerRecord, timeoutSec: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDependencies: Dependencies = {
  rcon: runServerRcon,
  runState: server => dockerService.runState(server),
  javaPids: server => dockerService.javaProcessIds(server),
  hardStop: (server, timeoutSec) => dockerService.stop(server, { timeoutSec }),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Stop a server the operator asked to stop, without killing Minecraft while it
 * is writing the world:
 *
 * 1. `save-all flush`, and check that Minecraft says the world is saved.
 * 2. `stop`, then wait for that JVM to exit — not merely the container, since
 *    pack scripts often relaunch the server in a loop and keep it alive.
 * 3. Only then stop the container. Once the JVM has exited, killing whatever
 *    the wrapper relaunched is harmless.
 *
 * Unlike automatic sleep (gracefulSleep), a manual stop still ends with the
 * server down when Minecraft does not cooperate; the outcome says whether a
 * running JVM had to be killed, so the caller can report it.
 */
export async function stopServerSafely(server: ServerRecord, deps: Dependencies = defaultDependencies): Promise<StopOutcome> {
  if (!(await deps.runState(server)).running) {
    return { saveConfirmed: false, jvmExited: true, killedRunningJvm: false };
  }

  const pids = await deps.javaPids(server);
  const saved = await deps.rcon(server, ['save-all flush'], { timeoutMs: SAVE_TIMEOUT_MS });
  const saveConfirmed = !!saved?.some(output => WORLD_SAVED.test(output));

  // Minecraft closes RCON while shutting down without answering `stop`, so a
  // null here does not mean the command was lost.
  const stopSent = saved !== null;
  if (stopSent) await deps.rcon(server, ['stop']).catch(() => null);

  if (!stopSent) {
    // No RCON at all (disabled, not ready, unreachable): Docker's SIGTERM is
    // the only way to ask the JVM to save.
    logger.warn({ serverId: server.id }, 'RCON unavailable; stopping with SIGTERM only');
    await deps.hardStop(server, NO_RCON_GRACE_SEC);
    const { exitCode } = await deps.runState(server);
    const killed = exitCode === 137;
    return { saveConfirmed: false, jvmExited: !killed, killedRunningJvm: killed };
  }

  const watchingJvm = !!pids?.length;
  const deadline = deps.now() + (watchingJvm ? SHUTDOWN_TIMEOUT_MS : CONTAINER_ONLY_TIMEOUT_MS);
  let jvmExited = false;
  while (deps.now() < deadline) {
    if (!(await deps.runState(server)).running) {
      return { saveConfirmed, jvmExited: true, killedRunningJvm: false };
    }
    if (watchingJvm) {
      const current = await deps.javaPids(server);
      if (current && !pids!.some(pid => current.includes(pid))) {
        jvmExited = true;
        break;
      }
    }
    await deps.sleep(POLL_MS);
  }

  if (jvmExited) {
    // Minecraft saved and exited; the container is only up because its start
    // script relaunched the server. Stop that promptly.
    await deps.hardStop(server, 5);
    return { saveConfirmed, jvmExited: true, killedRunningJvm: false };
  }

  logger.warn({ serverId: server.id, saveConfirmed, watchingJvm }, 'Minecraft did not finish shutting down in time; stopping the container');
  await deps.hardStop(server, 30);
  // Without a process list, a container that needed killing may only have been
  // a relaunched server; after a confirmed save that is not worth reporting.
  const { exitCode } = await deps.runState(server);
  const killedRunningJvm = exitCode === 137 && (watchingJvm || !saveConfirmed);
  return { saveConfirmed, jvmExited: !killedRunningJvm, killedRunningJvm };
}

/** Text for the dashboard's failure banner when a stop could not be clean, or null. */
export function unsafeStopMessage(outcome: StopOutcome): string | null {
  if (!outcome.killedRunningJvm) return null;
  return outcome.saveConfirmed
    ? 'Minecraft did not finish shutting down in time and was stopped by force. The world was saved just before, so at most the last few seconds of play may be lost.'
    : 'Minecraft could not be shut down cleanly and was stopped by force. The world save was not confirmed, so progress since the last autosave may be lost. Check the logs before starting it again.';
}
