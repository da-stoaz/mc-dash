import { dockerService } from './dockerService';
import { sendRconCommands } from './rconClient';
import { locateWorkingDir, readServerProperties, parseAccessEntry } from './prepareService';
import { logger } from '../logger';
import { ServerRecord } from '../types';

// RCON `ban`/`pardon` take a plain player name. Restrict to characters that
// can't break out of a single console command line; anything else is left to
// the file-based ban list (applied on the next restart) rather than injected.
const SAFE_RCON_NAME = /^[A-Za-z0-9_-]+$/;

function blacklistNames(list: string[] | undefined, enabled: boolean): string[] {
  if (!enabled) return [];
  const names = (list ?? [])
    .map(parseAccessEntry)
    .filter((entry): entry is { uuid: string; name: string } => entry !== null)
    .map((entry) => entry.name)
    .filter((name) => SAFE_RCON_NAME.test(name));
  return Array.from(new Set(names));
}

/**
 * Apply blacklist changes to a *running* server over RCON so bans take effect
 * immediately (and online players are kicked) without waiting for a restart.
 *
 * Best-effort: returns { applied: false } with a reason when RCON isn't reachable
 * (server stopped) or not active yet (enabled in server.properties but the server
 * hasn't restarted since). Callers keep the file-based behavior as the fallback.
 */
export async function syncBlacklistLive(
  server: ServerRecord,
  previous: { blacklist?: string[]; blacklistEnabled?: boolean }
): Promise<{ applied: boolean; reason?: string }> {
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

  const curEnabled = server.blacklistEnabled ?? (server.blacklist?.length ?? 0) > 0;
  const prevEnabled = previous.blacklistEnabled ?? (previous.blacklist?.length ?? 0) > 0;
  const current = blacklistNames(server.blacklist, curEnabled);
  const before = blacklistNames(previous.blacklist, prevEnabled);

  const toBan = current.filter((name) => !before.includes(name));
  const toPardon = before.filter((name) => !current.includes(name));
  const commands = [
    ...toBan.map((name) => `ban ${name} Banned via MC Dash`),
    ...toPardon.map((name) => `pardon ${name}`),
  ];
  if (commands.length === 0) return { applied: true };

  try {
    await sendRconCommands({ host: address.host, port: address.port, password, commands });
    logger.info({ serverId: server.id, banned: toBan, pardoned: toPardon }, 'Applied blacklist over RCON');
    return { applied: true };
  } catch (err) {
    logger.warn({ err, serverId: server.id }, 'Live RCON blacklist sync failed');
    return { applied: false, reason: 'RCON command failed' };
  }
}
