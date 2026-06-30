import { Difficulty } from '../types';

// Vanilla Minecraft difficulties, ordered to match the numeric values used by
// the server.properties `difficulty` key and the `/difficulty` console command
// on pre-1.13 servers (0=peaceful, 1=easy, 2=normal, 3=hard).
export const DIFFICULTIES: readonly Difficulty[] = ['peaceful', 'easy', 'normal', 'hard'];

const INDEX_BY_NAME: Record<Difficulty, number> = {
  peaceful: 0,
  easy: 1,
  normal: 2,
  hard: 3,
};

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

// Accept both the modern string form (peaceful/easy/normal/hard) and the legacy
// numeric form (0-3) that pre-1.13 servers write to server.properties, so we
// report a server's *actual* difficulty regardless of which format it uses.
export function parseDifficulty(raw?: string): Difficulty | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (isDifficulty(value)) return value;
  if (/^[0-3]$/.test(value)) return DIFFICULTIES[Number(value)];
  return undefined;
}

// True when the server stores difficulty numerically (pre-1.13). We mirror this
// format when writing back so we never hand a 1.13+ server a numeric value (it
// only accepts names) or vice-versa.
export function usesNumericFormat(raw?: string): boolean {
  return !!raw && /^[0-3]$/.test(raw.trim());
}

// Render a difficulty for either server.properties or the `/difficulty` RCON
// command, matching the format the server already uses.
export function formatDifficulty(difficulty: Difficulty, numeric: boolean): string {
  return numeric ? String(INDEX_BY_NAME[difficulty]) : difficulty;
}
