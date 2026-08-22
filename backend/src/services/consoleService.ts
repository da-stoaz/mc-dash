import crypto from 'crypto';
import { dockerService } from './dockerService';
import { sendRconCommands } from './rconClient';
import { locateWorkingDir, readServerProperties } from './prepareService';
import { UserFacingError } from '../apiErrors';
import { logger } from '../logger';
import { ServerRecord } from '../types';

/**
 * The server console: arbitrary Minecraft commands (`give`, `tp`, `kill`, …)
 * run against a live server over RCON, with their console output handed back.
 *
 * This deliberately does not reuse runServerRcon: that one flattens every
 * failure to null because its callers (player count, graceful stop) degrade
 * gracefully. Someone who just typed a command needs to know *why* it didn't
 * run, so everything here throws a UserFacingError the route can render.
 */

// Minecraft's RCON request body has to fit in one ~1460-byte packet. A command
// anywhere near that is a paste accident, not something someone typed.
export const MAX_COMMAND_LENGTH = 1000;

// Commands can take a while on a busy server (`save-all` on a large world), so
// this is more generous than the 5s the background pollers use.
const COMMAND_TIMEOUT_MS = 15_000;

// Per-server scrollback, kept in memory so the tab isn't blank after a reload
// or in a second browser tab. Not persisted: this is convenience, not an audit
// log, and it resets with the backend.
const HISTORY_LIMIT = 200;
const history = new Map<string, ConsoleEntry[]>();

export type ConsoleEntry = {
  id: string;
  command: string;
  output: string;
  at: string;
};

/**
 * Normalize what the user typed into what RCON accepts, rejecting the shapes
 * that can't be a real command.
 */
export function sanitizeCommand(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    throw new UserFacingError({
      error: 'Empty command',
      code: 'CONSOLE_COMMAND_EMPTY',
      reason: 'Type a command to run.',
    });
  }

  // People type commands the way they do in the in-game chat box, with a
  // leading slash. RCON wants them without one, and a stray `/give` otherwise
  // comes back as an unhelpful "Unknown or incomplete command".
  const command = (text.startsWith('/') ? text.slice(1) : text).trim();
  if (!command) {
    throw new UserFacingError({
      error: 'Empty command',
      code: 'CONSOLE_COMMAND_EMPTY',
      reason: 'Type a command to run.',
    });
  }

  // One packet carries one command. A newline can't chain a second one, but
  // refusing it outright beats sending something the server will only reject.
  if (/[\u0000-\u001f\u007f]/.test(command)) {
    throw new UserFacingError({
      error: 'Invalid command',
      code: 'CONSOLE_COMMAND_INVALID',
      reason: 'Run one command per line — line breaks and control characters are not allowed.',
    });
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    throw new UserFacingError({
      error: 'Command too long',
      code: 'CONSOLE_COMMAND_TOO_LONG',
      reason: `Commands are limited to ${MAX_COMMAND_LENGTH} characters; that one is ${command.length}.`,
    });
  }

  return command;
}

/** The first word, which is what decides how the command behaves for us. */
function verbOf(command: string): string {
  return command.split(/\s+/)[0]?.toLowerCase() ?? '';
}

// `stop` takes the RCON listener down with the server, so it never replies —
// the socket just closes. That is this command succeeding, not failing.
const SELF_TERMINATING = new Set(['stop']);

function isConnectionClosed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /closed before completing/i.test(message) || /ECONNRESET/i.test(message);
}

type Endpoint = { host: string; port: number; password: string };

/**
 * Where to reach this server's console, or a UserFacingError explaining which
 * precondition isn't met.
 */
async function resolveEndpoint(server: ServerRecord): Promise<Endpoint> {
  const address = await dockerService.rconAddress(server);
  if (!address) {
    throw new UserFacingError({
      error: 'Console unavailable',
      code: 'CONSOLE_SERVER_NOT_RUNNING',
      status: 409,
      reason: server.hibernated
        ? 'This server is hibernating. Start it, or let a player connect, before running commands.'
        : 'The console needs a running server. Start it and give it a moment to finish booting.',
    });
  }

  const workingDir = await locateWorkingDir(server);
  const props = workingDir ? await readServerProperties(workingDir) : {};
  const password = props['rcon.password']?.trim();
  const enabled = props['enable-rcon']?.trim().toLowerCase() === 'true';
  if (!enabled || !password) {
    throw new UserFacingError({
      error: 'Console unavailable',
      code: 'CONSOLE_RCON_DISABLED',
      status: 409,
      reason: 'RCON is off for this server. Run Prepare to enable it, then restart the server.',
    });
  }

  return { host: address.host, port: address.port, password };
}

/**
 * Run a single command on a live server and return what the console said.
 * Throws a UserFacingError when the command can't be delivered.
 */
export async function runConsoleCommand(server: ServerRecord, raw: unknown): Promise<ConsoleEntry> {
  const command = sanitizeCommand(raw);
  const endpoint = await resolveEndpoint(server);

  let output: string;
  try {
    const results = await sendRconCommands({
      host: endpoint.host,
      port: endpoint.port,
      password: endpoint.password,
      commands: [command],
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    output = results[0] ?? '';
  } catch (err) {
    if (SELF_TERMINATING.has(verbOf(command)) && isConnectionClosed(err)) {
      output = 'Server is shutting down.';
    } else {
      logger.warn({ err, serverId: server.id, command }, 'Console command failed');
      throw new UserFacingError({
        error: 'Command failed',
        code: 'CONSOLE_RCON_FAILED',
        status: 502,
        reason: (err as Error)?.message ?? 'The server did not answer.',
      });
    }
  }

  const entry: ConsoleEntry = {
    id: crypto.randomUUID(),
    command,
    output: output.trim(),
    at: new Date().toISOString(),
  };
  remember(server.id, entry);
  logger.info({ serverId: server.id, command }, 'Console command executed');
  return entry;
}

function remember(serverId: string, entry: ConsoleEntry): void {
  const entries = history.get(serverId) ?? [];
  entries.push(entry);
  if (entries.length > HISTORY_LIMIT) entries.splice(0, entries.length - HISTORY_LIMIT);
  history.set(serverId, entries);
}

/** Recent commands run through the console, oldest first. */
export function consoleHistory(serverId: string): ConsoleEntry[] {
  return history.get(serverId) ?? [];
}

export function clearConsoleHistory(serverId: string): void {
  history.delete(serverId);
}
