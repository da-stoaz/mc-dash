import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { config } from '../config';

function owner(): { uid: number; gid: number } | undefined {
  if (!config.containerUser) return undefined;
  const match = /^(\d+):(\d+)$/.exec(config.containerUser);
  if (!match) throw new Error('Minecraft file ownership requires MC_CONTAINER_USER in numeric uid:gid format.');
  const [uid, gid] = match.slice(1).map(Number);
  if (![uid, gid].every(n => Number.isSafeInteger(n) && n >= 0 && n < 4294967295)) {
    throw new Error('Invalid Minecraft uid:gid.');
  }
  return { uid, gid };
}

export function serverDirectory(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid server directory.');
  return path.join(config.dataRoot, 'servers', id);
}

// Validate every existing path component, not just the final file. In particular,
// never follow a pack's symlink when the backend is running as root.
async function checkedPath(file: string): Promise<void> {
  const base = path.resolve(config.dataRoot);
  const relative = path.relative(base, path.resolve(file));
  const parts = relative.split(path.sep);
  if (parts[0] !== 'servers' || parts.length < 2 || parts.some(p => p === '..' || !p)) {
    throw new Error('File is outside a managed server directory.');
  }
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink > 1)) {
      throw new Error(`Unsafe server file (link or special file): ${current}`);
    }
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
}

async function access(file: string, directory: boolean): Promise<void> {
  await checkedPath(file);
  // Use a descriptor so changing the final pathname cannot redirect chown/chmod.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1) {
      throw new Error(`Unsafe server file: ${file}`);
    }
    const target = owner();
    if (target && (stat.uid !== target.uid || stat.gid !== target.gid)) await handle.chown(target.uid, target.gid);
    const mode = (stat.mode & 0o777) | (directory ? 0o700 : 0o600);
    if ((stat.mode & 0o7777) !== mode) await handle.chmod(mode);
  } catch (error) {
    throw new Error(`Cannot grant Minecraft access to ${file}: ${(error as Error).message}`);
  } finally { await handle.close(); }
}

/** Repair only this server's working files. Snapshot archives remain backend-owned.
 * Call while stopped, before starting Minecraft, and after extraction/restore.
 * Two passes reject unsafe trees before changing ownership anywhere in the tree.
 */
export async function prepareServerFiles(id: string, repair = true): Promise<void> {
  const root = serverDirectory(id);
  await checkedPath(root);
  try { await fs.lstat(root); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const entries: { file: string; directory: boolean }[] = [];
  async function walk(file: string) {
    await checkedPath(file);
    const stat = await fs.lstat(file);
    entries.push({ file, directory: stat.isDirectory() });
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(file)) {
        if (file === root && name === 'snapshots') continue;
        await walk(path.join(file, name));
      }
    }
  }
  await walk(root);
  if (repair) for (const entry of entries) await access(entry.file, entry.directory);
}

/** Write configuration without following links, and preserve Minecraft ownership. */
export async function writeServerFile(file: string, content: string): Promise<void> {
  await checkedPath(file);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1) throw new Error(`Unsafe server file: ${file}`);
    const target = owner();
    if (target && (stat.uid !== target.uid || stat.gid !== target.gid)) await handle.chown(target.uid, target.gid);
    await handle.chmod((stat.mode & 0o777) | 0o600);
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } finally { await handle.close(); }
}
