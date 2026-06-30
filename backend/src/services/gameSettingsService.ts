import { dockerService } from './dockerService';
import { sendRconCommands } from './rconClient';
import { locateWorkingDir, readServerProperties } from './prepareService';
import { DIFFICULTIES, formatDifficulty, parseDifficulty, usesNumericFormat } from './difficulty';
import { logger } from '../logger';
import { Difficulty, ServerRecord } from '../types';

export type DifficultyOptions = {
  // Difficulties this server can actually be set to. Vanilla Minecraft supports
  // all four on every version; the one real per-server constraint is hardcore
  // mode, which forces (and locks) the world to Hard.
  available: Difficulty[];
  // The server's real current difficulty, read from server.properties when the
  // pack is prepared, falling back to the stored config otherwise.
  current: Difficulty | null;
  locked: boolean;
  lockedReason?: string;
  source: 'server.properties' | 'config';
};

function parseHardcore(raw?: string): boolean {
  return raw?.trim().toLowerCase() === 'true';
}

/**
 * Report which difficulties a specific server can be set to, and what it's set
 * to right now. Reads the prepared server.properties so the answer reflects the
 * actual server (including a hardcore lock) rather than a guess.
 */
export async function getDifficultyOptions(server: ServerRecord): Promise<DifficultyOptions> {
  const all = [...DIFFICULTIES];
  const workingDir = await locateWorkingDir(server);
  if (!workingDir) {
    // Not prepared yet: nothing on disk to constrain us, so all modes are open.
    return { available: all, current: server.game.difficulty ?? null, locked: false, source: 'config' };
  }

  const props = await readServerProperties(workingDir);
  const current = parseDifficulty(props['difficulty']) ?? server.game.difficulty ?? null;

  if (parseHardcore(props['hardcore'])) {
    return {
      available: ['hard'],
      current: 'hard',
      locked: true,
      lockedReason: 'Hardcore mode forces the difficulty to Hard.',
      source: 'server.properties',
    };
  }

  return { available: all, current, locked: false, source: 'server.properties' };
}

/**
 * Apply a difficulty change to a *running* server over RCON so it takes effect
 * immediately without a restart. Best-effort: returns { applied: false } with a
 * reason when the server isn't running, RCON isn't active yet, or the world is
 * hardcore-locked. Callers keep the file-based write (next start) as fallback.
 */
export async function syncDifficultyLive(
  server: ServerRecord,
  previousDifficulty: Difficulty | undefined
): Promise<{ applied: boolean; reason?: string }> {
  const next = server.game.difficulty;
  if (!next) return { applied: false, reason: 'no difficulty set' };
  if (next === previousDifficulty) return { applied: true };

  const address = await dockerService.rconAddress(server);
  if (!address) return { applied: false, reason: 'server not running' };

  const workingDir = await locateWorkingDir(server);
  if (!workingDir) return { applied: false, reason: 'pack not prepared' };

  const props = await readServerProperties(workingDir);
  const password = props['rcon.password']?.trim();
  const rconEnabled = props['enable-rcon']?.trim().toLowerCase() === 'true';
  if (!rconEnabled || !password) {
    return { applied: false, reason: 'RCON not active yet (restart to enable it)' };
  }
  if (parseHardcore(props['hardcore'])) {
    return { applied: false, reason: 'hardcore mode locks the difficulty to Hard' };
  }

  // Match the format the server uses for difficulty (numeric pre-1.13, names
  // after) so the console command is valid for that version.
  const command = `difficulty ${formatDifficulty(next, usesNumericFormat(props['difficulty']))}`;

  try {
    await sendRconCommands({ host: address.host, port: address.port, password, commands: [command] });
    logger.info({ serverId: server.id, difficulty: next }, 'Applied difficulty over RCON');
    return { applied: true };
  } catch (err) {
    logger.warn({ err, serverId: server.id }, 'Live RCON difficulty sync failed');
    return { applied: false, reason: 'RCON command failed' };
  }
}
