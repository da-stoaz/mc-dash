import { runServerRcon } from './rconService';
import { ServerRecord } from '../types';

export type PlayerInfo = {
  online: number;
  max: number;
  names: string[];
};

// Vanilla `list` output: "There are 3 of a max of 20 players online: Alice, Bob".
// Modded servers sometimes reword the prefix, so we match the two numbers
// loosely. Prefer UUID-qualified entries so display-name commas aren't separators.
const LIST_RE = /(\d+)\s*(?:\/|of a max of)\s*(\d+)/i;

export function parsePlayerList(raw: string): PlayerInfo | null {
  const text = raw.replace(/§[0-9a-fk-or]/gi, '').replace(/\u001b\[[0-9;]*m/g, '');
  const match = LIST_RE.exec(text);
  if (!match) return null;

  const online = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(online) || !Number.isFinite(max)) return null;

  // UUIDs delimit complete entries even when a mod adds commas to a title.
  const colon = text.indexOf(':', match.index + match[0].length);
  const roster = colon >= 0 ? text.slice(colon + 1).trim() : '';
  const entries = [...roster.matchAll(/(?:^|,\s*)(.*?)\s*\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi)];
  const candidates = entries.length
    ? entries.map(entry => entry[1].trim())
    : roster.split(',').map(name => name.trim()).filter(Boolean);
  // Never invent extra players from ambiguous decorated display names.
  const names = candidates.length === online ? candidates : [];

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
  const output = await runServerRcon(server, ['list uuids']);
  if (!output) return null;
  const players = parsePlayerList(output[0] ?? '');
  if (players) return players;
  // Older/modded command implementations may not support the UUID argument.
  const fallback = await runServerRcon(server, ['list']);
  return fallback ? parsePlayerList(fallback[0] ?? '') : null;
}
