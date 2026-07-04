import { dockerService } from './dockerService';
import { sendRconCommands } from './rconClient';
import { locateWorkingDir, readServerProperties } from './prepareService';
import { logger } from '../logger';
import { ServerRecord } from '../types';

export type PlayerInfo = {
  online: number;
  max: number;
  names: string[];
};

// Vanilla `list` output: "There are 3 of a max of 20 players online: Alice, Bob".
// Modded servers sometimes reword the prefix, so we match the two numbers
// loosely and treat the trailing segment after the last colon as the roster.
const LIST_RE = /(\d+)\s*(?:\/|of a max of)\s*(\d+)/i;

export function parsePlayerList(raw: string): PlayerInfo | null {
  const match = LIST_RE.exec(raw);
  if (!match) return null;

  const online = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(online) || !Number.isFinite(max)) return null;

  // Names follow the last ':' in the line; absent when nobody is online.
  const colon = raw.lastIndexOf(':');
  const roster = colon >= 0 ? raw.slice(colon + 1) : '';
  const names = roster
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return { online, max, names };
}

/**
 * Read the authoritative live player count from a *running* server over RCON.
 *
 * Returns null (an explicit "unknown") whenever the count can't be trusted:
 * the server is stopped, RCON isn't active yet, or the command failed. Callers
 * render that as unknown rather than a stale or fabricated number.
 */
export async function getPlayerCount(server: ServerRecord): Promise<PlayerInfo | null> {
  const address = await dockerService.rconAddress(server);
  if (!address) return null;

  const workingDir = await locateWorkingDir(server);
  if (!workingDir) return null;

  const props = await readServerProperties(workingDir);
  const password = props['rcon.password']?.trim();
  const rconEnabled = props['enable-rcon']?.trim().toLowerCase() === 'true';
  if (!rconEnabled || !password) return null;

  try {
    const [raw] = await sendRconCommands({
      host: address.host,
      port: address.port,
      password,
      commands: ['list'],
    });
    return parsePlayerList(raw ?? '');
  } catch (err) {
    logger.debug({ err, serverId: server.id }, 'Live player count query failed');
    return null;
  }
}
