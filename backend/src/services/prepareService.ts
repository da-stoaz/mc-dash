import path from 'path';
import fs from 'fs/promises';
import AdmZip from 'adm-zip';
import { config } from '../config';
import { logger } from '../logger';
import { ServerRecord } from '../types';
import { dockerService, RCON_PORT } from './dockerService';
import fsSync from 'fs';
import crypto from 'crypto';

const PRESERVE_DIRS = ['world', 'world_nether', 'world_the_end'];

async function pathExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function cleanPackDir(packDir: string) {
  await ensureDir(packDir);
  const entries = await fs.readdir(packDir, { withFileTypes: true });
  const preserved: { name: string; tempPath: string }[] = [];

  for (const entry of entries) {
    const fullPath = path.join(packDir, entry.name);
    if (entry.isDirectory() && PRESERVE_DIRS.includes(entry.name)) {
      const tempPath = path.join(packDir, `__preserve_${entry.name}`);
      await fs.rename(fullPath, tempPath);
      preserved.push({ name: entry.name, tempPath });
      continue;
    }
    await fs.rm(fullPath, { recursive: true, force: true });
  }

  for (const preservedEntry of preserved) {
    await fs.rename(preservedEntry.tempPath, path.join(packDir, preservedEntry.name));
  }
}

async function detectWorkingDir(packDir: string): Promise<string> {
  const entries = await fs.readdir(packDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  const dirs = entries.filter((e) => e.isDirectory());

  if (files.length === 0 && dirs.length === 1) {
    return path.join(packDir, dirs[0].name);
  }
  return packDir;
}

function toPosix(p: string) {
  return p.split(path.sep).join(path.posix.sep);
}

async function findStartScript(root: string): Promise<string | null> {
  const preferredNames = ['start.sh', 'startserver.sh', 'run.sh', 'launch.sh', 'serverstart.sh'];
  const queue: string[] = [root];
  let fallback: string | null = null;

  while (queue.length) {
    const dir = queue.shift();
    if (!dir) break;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Limit search depth to 2 to avoid deep traversals
        const depth = fullPath.replace(root, '').split(path.sep).length - 1;
        if (depth <= 2) queue.push(fullPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.sh')) {
          if (preferredNames.includes(lower)) return fullPath;
          if (!fallback) fallback = fullPath;
        }
      }
    }
  }
  return fallback;
}

async function findServerJar(workingDir: string): Promise<string | null> {
  const entries = await fs.readdir(workingDir, { withFileTypes: true });
  const jarFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'));
  const serverJar =
    jarFiles.find((entry) => entry.name.toLowerCase() === 'server.jar') ??
    jarFiles.find((entry) => entry.name.toLowerCase().includes('server'));
  return serverJar ? path.join(workingDir, serverJar.name) : null;
}

async function ensureStartScript(workingDir: string): Promise<string | null> {
  const existing = await findStartScript(workingDir);
  if (existing) return existing;

  const serverJar = await findServerJar(workingDir);
  if (!serverJar) return null;

  const scriptPath = path.join(workingDir, 'start.sh');
  const command = `java -jar "${path.basename(serverJar)}" nogui`;
  const script = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
${command}
`;
  await fs.writeFile(scriptPath, script, 'utf8');
  logger.info({ scriptPath }, 'Generated start.sh from server.jar');
  return scriptPath;
}

async function writeEula(workingDir: string) {
  const eulaPath = path.join(workingDir, 'eula.txt');
  await fs.writeFile(eulaPath, 'eula=true\n');
}

async function applyServerProperties(workingDir: string, server: ServerRecord) {
  const propsPath = path.join(workingDir, 'server.properties');
  const props: Record<string, string> = {};

  if (await pathExists(propsPath)) {
    const content = await fs.readFile(propsPath, 'utf8');
    content.split('\n').forEach((line) => {
      if (!line || line.startsWith('#') || !line.includes('=')) return;
      const [key, ...rest] = line.split('=');
      props[key.trim()] = rest.join('=').trim();
    });
  }

  if (typeof server.game.renderDistance === 'number') {
    props['view-distance'] = String(server.game.renderDistance);
  }
  if (server.game.gameMode) {
    const modeMap: Record<string, string> = {
      survival: '0',
      creative: '1',
      adventure: '2',
      spectator: '3',
    };
    props['gamemode'] = modeMap[server.game.gameMode];
    props['force-gamemode'] = 'true';
  }
  if (server.game.seed) {
    props['level-seed'] = server.game.seed;
  }
  if (server.serverPort) {
    props['server-port'] = String(server.serverPort);
  }
  if (server.whitelistEnabled !== undefined || server.whitelist !== undefined) {
    const enabled = server.whitelistEnabled ?? (server.whitelist?.length ?? 0) > 0;
    props['white-list'] = enabled ? 'true' : 'false';
    props['enforce-whitelist'] = enabled ? 'true' : 'false';
  }

  // Enable RCON so MC Dash can push bans / access-list changes to a running
  // server without a restart. The password is generated once and preserved on
  // subsequent writes. RCON only becomes active after the server next (re)starts
  // with these properties, which is the one-time bootstrap for live bans.
  props['enable-rcon'] = 'true';
  props['rcon.port'] = String(RCON_PORT);
  if (!props['rcon.password']?.trim()) {
    props['rcon.password'] = crypto.randomBytes(24).toString('hex');
  }
  props['broadcast-rcon-to-ops'] = 'false';

  const lines = Object.entries(props).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(propsPath, lines.join('\n') + '\n');
}

// ServerPackCreator start scripts download the modloader server jar (Fabric
// launcher, NeoForge ServerStarterJar, etc.) at first run using curl or wget.
// Bare JRE images (e.g. eclipse-temurin:*-jre) ship with neither, which makes
// the pack crash with a misleading message like "Fabric is not available...".
// So before running the pack's script, ensure a downloader is present. This is
// best-effort and supports the common base-image package managers.
function buildStartCommand(scriptName: string): string {
  // scriptName comes from path.basename of a script we located/wrote, so it has
  // no shell metacharacters; still, keep it in single quotes defensively.
  const safeName = scriptName.replace(/'/g, `'\\''`);
  return [
    'if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then',
    '  echo "[mc-dash] Installing curl (required by the server pack start script)...";',
    '  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends curl ca-certificates;',
    '  elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates;',
    '  elif command -v microdnf >/dev/null 2>&1; then microdnf install -y curl ca-certificates;',
    '  elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates;',
    '  elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates;',
    '  else echo "[mc-dash] WARNING: no supported package manager found to install curl/wget; the pack may fail to download its modloader.";',
    '  fi;',
    'fi;',
    `exec bash './${safeName}'`,
  ].join('\n');
}

async function buildContainerFromPack(
  server: ServerRecord,
  serverRoot: string,
  workingDir: string,
  varsResult: { recommendedJavaVersion?: string }
): Promise<{
  containerId: string;
  script: string;
  image: string;
  javaSource: 'override' | 'env' | 'pack' | 'default';
  packRecommendedJava?: string;
  packRecommendedJavaMajor?: number;
}> {
  const scriptPath = await ensureStartScript(workingDir);
  if (!scriptPath) {
    throw new Error('Could not find a start script or server.jar inside the server pack');
  }
  await fs.chmod(scriptPath, 0o755);

  const scriptDir = path.dirname(scriptPath);
  const containerWorkdir = toPosix(path.join('/server', path.relative(serverRoot, scriptDir)));
  const cmd = ['bash', '-c', buildStartCommand(path.basename(scriptPath))];

  const memoryBytes = server.resources?.maxRamMb ? server.resources.maxRamMb * 1024 * 1024 : undefined;
  const nanoCpus = server.resources?.cpuLimit ? Math.round(server.resources.cpuLimit * 1_000_000_000) : undefined;

  const packRecommendedJava = varsResult.recommendedJavaVersion ?? (await detectRecommendedJavaFromScript(scriptPath));
  const javaResolution = resolveJavaImage(server.javaImage, packRecommendedJava);
  const image = javaResolution.image;

  const containerId = await dockerService.createOrReplaceContainer(server, {
    image,
    hostServerDir: serverRoot,
    workdir: containerWorkdir,
    cmd,
    port: server.serverPort ?? config.serverPort,
    memoryBytes,
    nanoCpus,
  });

  return {
    containerId,
    script: scriptPath,
    image,
    javaSource: javaResolution.source,
    packRecommendedJava,
    packRecommendedJavaMajor: javaResolution.recommendedMajor,
  };
}

async function applyVariablesTxt(workingDir: string, server: ServerRecord): Promise<{ recommendedJavaVersion?: string }> {
  const varsPath = await findVariablesTxt(workingDir);
  if (!varsPath) {
    logger.warn({ workingDir }, 'variables.txt not found; skipping variable updates');
    return {};
  }

  try {
    const content = await fs.readFile(varsPath, 'utf8');
    const lines = content.split('\n');

    const normalizeKey = (raw: string) => {
      const trimmed = raw.trim();
      const withoutExport = trimmed.toLowerCase().startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
      return withoutExport.toUpperCase();
    };

    const parsed = lines.map((line) => {
      if (!line || line.startsWith('#') || !line.includes('=')) return { kind: 'other' as const, line };
      const idx = line.indexOf('=');
      const rawKeyPart = line.slice(0, idx).trim();
      const prefix = rawKeyPart.toLowerCase().startsWith('export ') ? rawKeyPart.slice(0, 'export '.length) : '';
      const key = prefix ? rawKeyPart.slice('export '.length).trim() : rawKeyPart;
      const normalizedKey = normalizeKey(rawKeyPart);
      const value = line.slice(idx + 1).trim();
      return { kind: 'kv' as const, line, prefix, key, normalizedKey, value };
    });

    const originalMap: Record<string, string> = {};
    parsed.forEach((entry) => {
      if (entry.kind !== 'kv') return;
      originalMap[entry.normalizedKey] = entry.value;
    });

    // Respect user-set JVM args if present; otherwise derive from resources
    const desired: Record<string, string> = {};
    if (server.resources.maxRamMb && server.resources.minRamMb) {
      desired['JAVA_ARGS'] = `"-Xmx${server.resources.maxRamMb}M -Xms${server.resources.minRamMb}M"`;
    }

    // Container already has Java; skip interactive installer
    desired['SKIP_JAVA_CHECK'] = 'true';
    desired['WAIT_FOR_USER_INPUT'] = 'false';
    desired['JAVA'] = 'java';

    const newLines = parsed.map((entry) => {
      if (entry.kind !== 'kv') return entry.line;
      const replacement = desired[entry.normalizedKey];
      if (replacement !== undefined) {
        return `${entry.prefix}${entry.key}=${replacement}`;
      }
      return entry.line;
    });

    // Add any new keys not present
    Object.entries(desired).forEach(([key, value]) => {
      const normalized = key.toUpperCase();
      const hasKey = parsed.some((entry) => entry.kind === 'kv' && entry.normalizedKey === normalized);
      if (!hasKey) {
        newLines.push(`${key}=${value}`);
      }
    });

    await fs.writeFile(varsPath, newLines.join('\n'));

    // Use the original values from the pack for detection (not our overrides).
    const recommendedJavaVersion =
      originalMap['RECOMMENDED_JAVA_VERSION'] ??
      originalMap['JAVA_VERSION'] ??
      originalMap['JAVA_MAJOR_VERSION'] ??
      originalMap['MINIMUM_JAVA_VERSION'] ??
      originalMap['MIN_JAVA_VERSION'] ??
      originalMap['MIN_JAVA'];
    return { recommendedJavaVersion };
  } catch (err) {
    logger.warn({ err }, 'variables.txt not updated (file may be missing)');
    return {};
  }
}

async function detectRecommendedJavaFromScript(scriptPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(scriptPath, 'utf8');
    const lines = content.split('\n');
    const keyPattern =
      /\b(?:export\s+)?(RECOMMENDED_JAVA_VERSION|JAVA_VERSION|JAVA_MAJOR_VERSION|MINIMUM_JAVA_VERSION|MIN_JAVA_VERSION|MIN_JAVA)\s*=\s*(.+)\s*$/i;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(keyPattern);
      if (!match) continue;
      const value = match[2]?.split('#')[0]?.trim();
      if (!value) continue;
      return value;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function findVariablesTxt(root: string): Promise<string | null> {
  const upwardDirs: string[] = [];
  const rootResolved = path.resolve(root);
  upwardDirs.push(rootResolved);
  upwardDirs.push(path.dirname(rootResolved));
  upwardDirs.push(path.dirname(path.dirname(rootResolved)));
  const uniqueUpwardDirs = Array.from(new Set(upwardDirs));

  for (const dir of uniqueUpwardDirs) {
    const direct = path.join(dir, 'variables.txt');
    if (await pathExists(direct)) return direct;
  }

  // Some packs nest scripts/variables under a pack folder; search shallowly.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    let entries: Array<import('fs').Dirent> = [];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nextDepth = current.depth + 1;
      if (nextDepth > 6) continue;
      const nextDir = path.join(current.dir, entry.name);
      const candidate = path.join(nextDir, 'variables.txt');
      if (await pathExists(candidate)) return candidate;
      queue.push({ dir: nextDir, depth: nextDepth });
    }
  }
  return null;
}

async function applyUserJvmArgs(workingDir: string, server: ServerRecord) {
  const argsPath = path.join(workingDir, 'user_jvm_args.txt');
  if (!(await pathExists(argsPath))) return;
  if (!server.resources.minRamMb || !server.resources.maxRamMb) return;

  try {
    const content = await fs.readFile(argsPath, 'utf8');
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return true;
      return !(trimmed.startsWith('-Xms') || trimmed.startsWith('-Xmx'));
    });
    filtered.push(`-Xms${server.resources.minRamMb}M`);
    filtered.push(`-Xmx${server.resources.maxRamMb}M`);
    await fs.writeFile(argsPath, filtered.join('\n') + '\n');
  } catch (err) {
    logger.warn({ err }, 'user_jvm_args.txt not updated (file may be missing)');
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function formatUuid(bytes: Buffer) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function offlineUuid(name: string) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash);
}

export function parseAccessEntry(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let name = trimmed;
  let uuid = '';

  if (trimmed.includes(':')) {
    const [first, second] = trimmed.split(':').map((part) => part.trim());
    if (isUuid(first)) {
      uuid = first;
      name = second || first;
    } else if (isUuid(second)) {
      uuid = second;
      name = first || second;
    }
  }

  if (!uuid && isUuid(trimmed)) {
    uuid = trimmed;
    name = trimmed;
  }

  // Leave uuid empty for name-only entries so resolveAccessEntries can pick the
  // correct UUID: the real Mojang UUID on online-mode servers, the offline
  // (md5-derived) UUID otherwise. Filling offlineUuid() here would shadow that
  // logic and write a UUID that never matches how a premium player connects.
  return { uuid, name };
}

function parseOnlineMode(raw?: string): boolean {
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== 'false' && normalized !== '0' && normalized !== 'no';
}

export async function readServerProperties(workingDir: string): Promise<Record<string, string>> {
  const propsPath = path.join(workingDir, 'server.properties');
  const props: Record<string, string> = {};
  if (!(await pathExists(propsPath))) return props;

  const content = await fs.readFile(propsPath, 'utf8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
    const [key, ...rest] = trimmed.split('=');
    props[key.trim()] = rest.join('=').trim();
  });
  return props;
}

const mojangUuidCache = new Map<string, string>();
async function resolveMojangUuid(username: string): Promise<string | null> {
  const normalized = username.trim();
  if (!normalized) return null;
  const cacheKey = normalized.toLowerCase();
  const cached = mojangUuidCache.get(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(normalized)}`, {
      signal: controller.signal,
      headers: { 'accept': 'application/json' },
    });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    const id = data?.id?.trim();
    if (!id || !/^[0-9a-f]{32}$/i.test(id)) return null;
    const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    mojangUuidCache.set(cacheKey, uuid);
    return uuid;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveAccessEntries(
  rawEntries: string[] | undefined,
  options: { onlineMode: boolean }
): Promise<{ resolved: Array<{ uuid: string; name: string }>; unresolved: string[] }> {
  const parsed = (rawEntries ?? []).map(parseAccessEntry).filter((entry): entry is { uuid: string; name: string } => entry !== null);
  const resolved: Array<{ uuid: string; name: string }> = [];
  const unresolved: string[] = [];

  for (const entry of parsed) {
    if (entry.uuid) {
      resolved.push(entry);
      continue;
    }
    if (options.onlineMode) {
      const mojangUuid = await resolveMojangUuid(entry.name);
      if (mojangUuid) {
        resolved.push({ uuid: mojangUuid, name: entry.name });
      } else {
        // Online-mode server: never fall back to the offline UUID for a name we
        // can't resolve. It would never match how the player actually connects,
        // silently producing an ineffective ban/whitelist. Skip and report it.
        unresolved.push(entry.name);
      }
      continue;
    }
    resolved.push({ uuid: offlineUuid(entry.name), name: entry.name });
  }

  return { resolved, unresolved };
}

async function applyAccessLists(workingDir: string, server: ServerRecord) {
  const whitelist = server.whitelist?.map((entry) => entry.trim()).filter(Boolean);
  const blacklist = server.blacklist?.map((entry) => entry.trim()).filter(Boolean);
  const now = new Date().toISOString();
  const whitelistEnabled = server.whitelistEnabled ?? (whitelist?.length ?? 0) > 0;
  const blacklistEnabled = server.blacklistEnabled ?? (blacklist?.length ?? 0) > 0;
  const serverProps = await readServerProperties(workingDir);
  const onlineMode = parseOnlineMode(serverProps['online-mode']);

  const unresolved: string[] = [];

  if (server.whitelist !== undefined || server.whitelistEnabled !== undefined) {
    const { resolved, unresolved: u } = whitelistEnabled
      ? await resolveAccessEntries(whitelist, { onlineMode })
      : { resolved: [], unresolved: [] };
    unresolved.push(...u);
    const whitelistPath = path.join(workingDir, 'whitelist.json');
    await fs.writeFile(whitelistPath, JSON.stringify(resolved, null, 2) + '\n');
  }

  if (server.blacklist !== undefined || server.blacklistEnabled !== undefined) {
    const { resolved, unresolved: u } = blacklistEnabled
      ? await resolveAccessEntries(blacklist, { onlineMode })
      : { resolved: [], unresolved: [] };
    unresolved.push(...u);
    const entries = resolved.map((entry) => ({
      uuid: entry.uuid,
      name: entry.name,
      created: now,
      source: 'mc-dash',
      expires: 'forever',
      reason: 'Banned via MC Dash',
    }));
    const blacklistPath = path.join(workingDir, 'banned-players.json');
    await fs.writeFile(blacklistPath, JSON.stringify(entries, null, 2) + '\n');
  }

  // Resolved entries were written above so valid bans/whitelist still apply.
  // Surface any names we couldn't resolve so the save reports them instead of
  // silently dropping the entry.
  if (unresolved.length > 0) {
    throw new Error(
      `Could not resolve a Minecraft UUID for: ${unresolved.join(', ')}. ` +
        `On an online-mode server these entries were skipped (the offline UUID would never match). ` +
        `Check the spelling or paste the player's UUID directly.`
    );
  }
}

async function ensureZipExtracted(zipPath: string, packDir: string): Promise<string> {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(packDir, true);
  return packDir;
}

function resolveJavaImage(serverJavaImage?: string, recommended?: string): {
  image: string;
  source: 'override' | 'env' | 'pack' | 'default';
  recommendedMajor?: number;
} {
  const trimmed = serverJavaImage?.trim();
  if (trimmed && trimmed.toLowerCase() !== 'auto') {
    return { image: trimmed, source: 'override' };
  }

  const recommendedMajor = parseRecommendedJavaMajor(recommended);
  if (recommendedMajor) {
    return { image: `eclipse-temurin:${recommendedMajor}-jre`, source: 'pack', recommendedMajor };
  }

  return { image: config.javaImage, source: 'default' };
}

function parseRecommendedJavaMajor(recommended?: string): number | undefined {
  if (!recommended) return undefined;
  const normalized = recommended.replace(/['"]/g, '').trim().toLowerCase();
  if (!normalized) return undefined;

  // Common patterns: "21", "21.0.2", "java 21", "temurin-21"
  const explicitJava = normalized.match(/\bjava[^0-9]*([0-9]{1,2})\b/);
  if (explicitJava) {
    const major = Number(explicitJava[1]);
    if (Number.isFinite(major) && major > 0) return major;
  }

  // Some packs use Minecraft version-ish strings; map to the Java major Minecraft expects.
  const minecraft = normalized.match(/\b1\.(\d{1,2})\b/);
  if (minecraft) {
    const minor = Number(minecraft[1]);
    if (minor >= 21) return 21;
    if (minor >= 18) return 17;
    if (minor === 17) return 16;
    return 8;
  }

  const firstNumber = normalized.match(/\b([0-9]{1,2})\b/);
  if (firstNumber) {
    const major = Number(firstNumber[1]);
    if (Number.isFinite(major) && major > 0) return major;
  }

  return undefined;
}

async function getServerPackArchive(serverPackUrl: string, downloadsDir: string): Promise<string> {
  if (serverPackUrl.startsWith('http://') || serverPackUrl.startsWith('https://')) {
    throw new Error('Remote URLs are not supported. Upload the server pack zip instead.');
  }

  const filePath = serverPackUrl.startsWith('file://') ? new URL(serverPackUrl).pathname : serverPackUrl;
  const resolved = path.resolve(filePath);
  if (!fsSync.existsSync(resolved)) {
    throw new Error(`Server pack file not found at ${resolved}`);
  }
  const dest = path.join(downloadsDir, path.basename(resolved));
  await fs.copyFile(resolved, dest);
  logger.info({ dest }, 'Copied server pack file');
  return dest;
}

export async function prepareServer(server: ServerRecord): Promise<{
  containerId: string;
  script: string;
  image: string;
  javaSource: 'override' | 'env' | 'pack' | 'default';
  packRecommendedJava?: string;
  packRecommendedJavaMajor?: number;
}> {
  if (!server.serverPackUrl) {
    throw new Error('Server is missing an uploaded server pack');
  }

  const serverRoot = path.join(config.dataRoot, 'servers', server.id);
  const downloadsDir = path.join(serverRoot, 'downloads');
  const packDir = path.join(serverRoot, 'pack');

  await ensureDir(serverRoot);
  await ensureDir(downloadsDir);
  await ensureDir(packDir);

  const zipPath = await getServerPackArchive(server.serverPackUrl, downloadsDir);
  await cleanPackDir(packDir);
  await ensureZipExtracted(zipPath, packDir);

  const workingDir = await detectWorkingDir(packDir);
  await writeEula(workingDir);
  await applyServerProperties(workingDir, server);
  const varsResult = await applyVariablesTxt(workingDir, server);
  await applyUserJvmArgs(workingDir, server);
  await applyAccessLists(workingDir, server);

  return buildContainerFromPack(server, serverRoot, workingDir, varsResult);
}

export async function recreateContainer(server: ServerRecord): Promise<{
  containerId: string;
  script: string;
  image: string;
  javaSource: 'override' | 'env' | 'pack' | 'default';
  packRecommendedJava?: string;
  packRecommendedJavaMajor?: number;
}> {
  const serverRoot = path.join(config.dataRoot, 'servers', server.id);
  const packDir = path.join(serverRoot, 'pack');

  if (!(await pathExists(packDir))) {
    throw new Error('Server pack not prepared yet');
  }

  const workingDir = await detectWorkingDir(packDir);
  await writeEula(workingDir);
  await applyServerProperties(workingDir, server);
  const varsResult = await applyVariablesTxt(workingDir, server);
  await applyUserJvmArgs(workingDir, server);
  await applyAccessLists(workingDir, server);

  return buildContainerFromPack(server, serverRoot, workingDir, varsResult);
}

// Resolve a prepared server's working directory (the folder that actually holds
// server.properties / banned-players.json), or null if the pack isn't prepared.
export async function locateWorkingDir(server: ServerRecord): Promise<string | null> {
  const packDir = path.join(config.dataRoot, 'servers', server.id, 'pack');
  if (!(await pathExists(packDir))) return null;
  return detectWorkingDir(packDir);
}

export async function applyConfigFiles(server: ServerRecord): Promise<void> {
  const serverRoot = path.join(config.dataRoot, 'servers', server.id);
  const packDir = path.join(serverRoot, 'pack');

  if (!(await pathExists(packDir))) {
    throw new Error('Server pack not prepared yet');
  }

  const workingDir = await detectWorkingDir(packDir);
  await applyServerProperties(workingDir, server);
  await applyVariablesTxt(workingDir, server);
  await applyUserJvmArgs(workingDir, server);
  await applyAccessLists(workingDir, server);
}
