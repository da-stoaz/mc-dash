import path from 'path';
import fs from 'fs/promises';
import AdmZip from 'adm-zip';
import { config } from '../config';
import { logger } from '../logger';
import { ServerRecord } from '../types';
import { dockerService } from './dockerService';
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

  const lines = Object.entries(props).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(propsPath, lines.join('\n') + '\n');
}

async function buildContainerFromPack(
  server: ServerRecord,
  serverRoot: string,
  workingDir: string,
  varsResult: { recommendedJavaVersion?: string }
): Promise<{ containerId: string; script: string; image: string }> {
  const scriptPath = await ensureStartScript(workingDir);
  if (!scriptPath) {
    throw new Error('Could not find a start script or server.jar inside the server pack');
  }
  await fs.chmod(scriptPath, 0o755);

  const scriptDir = path.dirname(scriptPath);
  const containerWorkdir = toPosix(path.join('/server', path.relative(serverRoot, scriptDir)));
  const cmd = ['bash', `./${path.basename(scriptPath)}`];

  const memoryBytes = server.resources?.maxRamMb ? server.resources.maxRamMb * 1024 * 1024 : undefined;
  const nanoCpus = server.resources?.cpuLimit ? Math.round(server.resources.cpuLimit * 1_000_000_000) : undefined;

  const image = chooseJavaImage(server.javaImage, varsResult.recommendedJavaVersion);

  const containerId = await dockerService.createOrReplaceContainer(server, {
    image,
    hostServerDir: serverRoot,
    workdir: containerWorkdir,
    cmd,
    port: server.serverPort ?? config.serverPort,
    memoryBytes,
    nanoCpus,
  });

  return { containerId, script: scriptPath, image };
}

async function applyVariablesTxt(workingDir: string, server: ServerRecord): Promise<{ recommendedJavaVersion?: string }> {
  const varsPath = path.join(workingDir, 'variables.txt');
  try {
    const content = await fs.readFile(varsPath, 'utf8');
    const lines = content.split('\n');
    const map: Record<string, string> = {};
    lines.forEach((line) => {
      if (!line || line.startsWith('#') || !line.includes('=')) return;
      const idx = line.indexOf('=');
      const rawKey = line.slice(0, idx).trim();
      const key = rawKey.toLowerCase().startsWith('export ') ? rawKey.slice('export '.length).trim() : rawKey;
      const value = line.slice(idx + 1).trim();
      map[key] = value;
    });

    // Respect user-set JVM args if present; otherwise derive from resources
    if (server.resources.maxRamMb && server.resources.minRamMb) {
      map['JAVA_ARGS'] = `"-Xmx${server.resources.maxRamMb}M -Xms${server.resources.minRamMb}M"`;
    }

    // Container already has Java; skip interactive installer
    map['SKIP_JAVA_CHECK'] = 'true';
    map['WAIT_FOR_USER_INPUT'] = 'false';
    map['JAVA'] = 'java';

    const newLines = lines.map((line) => {
      if (!line || line.startsWith('#') || !line.includes('=')) return line;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      if (map[key] !== undefined) {
        return `${key}=${map[key]}`;
      }
      return line;
    });

    // Add any new keys not present
    ['JAVA_ARGS', 'SKIP_JAVA_CHECK', 'WAIT_FOR_USER_INPUT', 'JAVA'].forEach((key) => {
      if (!newLines.some((l) => l.startsWith(`${key}=`))) {
        newLines.push(`${key}=${map[key]}`);
      }
    });

    await fs.writeFile(varsPath, newLines.join('\n'));
    const recommendedJavaVersion =
      map['RECOMMENDED_JAVA_VERSION'] ??
      map['JAVA_VERSION'] ??
      map['JAVA_MAJOR_VERSION'] ??
      map['MINIMUM_JAVA_VERSION'] ??
      map['MIN_JAVA_VERSION'] ??
      map['MIN_JAVA'] ??
      map['JAVA'];
    return { recommendedJavaVersion };
  } catch (err) {
    logger.warn({ err }, 'variables.txt not updated (file may be missing)');
    return {};
  }
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

function parseAccessEntry(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let name = trimmed;
  let uuid: string | null = null;

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

  if (!uuid) {
    uuid = offlineUuid(name);
  }

  return { uuid, name };
}

async function applyAccessLists(workingDir: string, server: ServerRecord) {
  const whitelist = server.whitelist?.map((entry) => entry.trim()).filter(Boolean);
  const blacklist = server.blacklist?.map((entry) => entry.trim()).filter(Boolean);
  const ipBlacklist = server.ipBlacklist?.map((entry) => entry.trim()).filter(Boolean);
  const isEntry = (entry: { uuid: string; name: string } | null): entry is { uuid: string; name: string } => entry !== null;
  const now = new Date().toISOString();
  const whitelistEnabled = server.whitelistEnabled ?? (whitelist?.length ?? 0) > 0;
  const blacklistEnabled = server.blacklistEnabled ?? (blacklist?.length ?? 0) > 0;
  const ipBlacklistEnabled = server.ipBlacklistEnabled ?? (ipBlacklist?.length ?? 0) > 0;

  if (server.whitelist !== undefined || server.whitelistEnabled !== undefined) {
    const entries = whitelistEnabled ? (whitelist ?? []).map(parseAccessEntry).filter(isEntry) : [];
    const whitelistPath = path.join(workingDir, 'whitelist.json');
    await fs.writeFile(whitelistPath, JSON.stringify(entries, null, 2) + '\n');
  }

  if (server.blacklist !== undefined || server.blacklistEnabled !== undefined) {
    const entries = blacklistEnabled
      ? (blacklist ?? []).map(parseAccessEntry).filter(isEntry).map((entry) => ({
          ...entry,
          created: now,
          source: 'mc-dash',
          expires: 'forever',
          reason: 'Banned via MC Dash',
        }))
      : [];
    const blacklistPath = path.join(workingDir, 'banned-players.json');
    await fs.writeFile(blacklistPath, JSON.stringify(entries, null, 2) + '\n');
  }

  if (server.ipBlacklist !== undefined || server.ipBlacklistEnabled !== undefined) {
    const entries = ipBlacklistEnabled
      ? (ipBlacklist ?? []).map((ip) => ({
          ip,
          created: now,
          source: 'mc-dash',
          expires: 'forever',
          reason: 'Banned via MC Dash',
        }))
      : [];
    const blacklistPath = path.join(workingDir, 'banned-ips.json');
    await fs.writeFile(blacklistPath, JSON.stringify(entries, null, 2) + '\n');
  }
}

async function ensureZipExtracted(zipPath: string, packDir: string): Promise<string> {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(packDir, true);
  return packDir;
}

function chooseJavaImage(serverJavaImage?: string, recommended?: string): string {
  const trimmed = serverJavaImage?.trim();
  if (trimmed && trimmed.toLowerCase() !== 'auto') {
    return trimmed;
  }
  if (process.env.JAVA_IMAGE && process.env.JAVA_IMAGE.trim().length > 0) {
    return process.env.JAVA_IMAGE.trim();
  }

  const recommendedMajor = parseRecommendedJavaMajor(recommended);
  if (recommendedMajor) {
    return `eclipse-temurin:${recommendedMajor}-jre`;
  }

  return config.javaImage;
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

export async function prepareServer(server: ServerRecord): Promise<{ containerId: string; script: string; image: string }> {
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

export async function recreateContainer(server: ServerRecord): Promise<{ containerId: string; script: string; image: string }> {
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
