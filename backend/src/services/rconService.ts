import { dockerService } from './dockerService';
import { sendRconCommands } from './rconClient';
import { locateWorkingDir, readServerProperties } from './prepareService';
import { logger } from '../logger';
import { ServerRecord } from '../types';

/**
 * Resolve a running server's RCON endpoint + password and run the given
 * commands, returning each command's output. Returns null (rather than throwing)
 * whenever RCON can't be used: the server is stopped, RCON isn't active yet, the
 * endpoint is unreachable, or the command failed. Callers treat null as "RCON
 * unavailable" and degrade gracefully.
 */
export async function runServerRcon(
  server: ServerRecord,
  commands: string[],
  opts: { timeoutMs?: number } = {}
): Promise<string[] | null> {
  const address = await dockerService.rconAddress(server);
  if (!address) return null;

  const workingDir = await locateWorkingDir(server);
  if (!workingDir) return null;

  const props = await readServerProperties(workingDir);
  const password = props['rcon.password']?.trim();
  const rconEnabled = props['enable-rcon']?.trim().toLowerCase() === 'true';
  if (!rconEnabled || !password) return null;

  try {
    return await sendRconCommands({
      host: address.host,
      port: address.port,
      password,
      commands,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    logger.debug({ err, serverId: server.id }, 'RCON command failed');
    return null;
  }
}
