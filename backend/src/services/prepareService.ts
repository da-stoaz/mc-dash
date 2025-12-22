import path from 'path';
import fs from 'fs/promises';
import AdmZip from 'adm-zip';
import { config } from '../config';
import { logger } from '../logger';
import { ServerRecord } from '../types';
import { dockerService } from './dockerService';
import fsSync from 'fs';

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

  const lines = Object.entries(props).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(propsPath, lines.join('\n') + '\n');
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
      const key = line.slice(0, idx).trim();
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
    return { recommendedJavaVersion: map['RECOMMENDED_JAVA_VERSION'] };
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
  if (recommended) {
    // Try to derive major from patterns like 1.21.x or 21
    const match21 = recommended.match(/1\.21|^21/);
    const match20 = recommended.match(/1\.20|^20/);
    const match19 = recommended.match(/1\.19|^19/);
    const match17 = recommended.match(/1\.17|^17/);
    const match8 = recommended.match(/1\.8|^8/);
    if (match21) return 'eclipse-temurin:21-jre';
    if (match20) return 'eclipse-temurin:21-jre'; // Java 21 is fine for 20+ in most cases
    if (match19) return 'eclipse-temurin:19-jre';
    if (match17) return 'eclipse-temurin:17-jre';
    if (match8) return 'eclipse-temurin:8-jre';
  }
  return config.javaImage;
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

export async function prepareServer(server: ServerRecord): Promise<{ containerId: string; script: string }> {
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
    port: config.serverPort,
    memoryBytes,
    nanoCpus,
  });

  return { containerId, script: scriptPath };
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
}
