import Docker, { Container } from 'dockerode';
import { PassThrough } from 'stream';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config';
import { logger } from '../logger';
import { ServerRecord, ServerStatus } from '../types';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildDockerClient(): Docker {
  const apiVersion = config.dockerApiVersion;
  if (config.dockerHost) {
    return new Docker({ host: config.dockerHost, version: apiVersion });
  }
  return new Docker({
    socketPath: config.dockerSocketPath ?? '/var/run/docker.sock',
    version: apiVersion,
  });
}

export class DockerService {
  private docker: Docker;
  private readonly readyPatterns = [
    /Done \([0-9.,]+s\)! For help, type "help"/i,
    /For help, type "help"/i,
    /Server started/i,
    /Server ready/i,
    /Listening on .*:\d+/i,
  ];
  private readonly startPatterns = [
    /Starting minecraft server/i,
    /Starting Minecraft server/i,
    /Starting server/i,
    /Preparing spawn area/i,
    /Loading properties/i,
  ];

  constructor() {
    this.docker = buildDockerClient();
  }

  containerName(serverId: string) {
    return `mc-dash-${serverId}`;
  }

  private async getContainer(server: ServerRecord): Promise<Container> {
    if (server.containerId) {
      const byId = this.docker.getContainer(server.containerId);
      try {
        await byId.inspect();
        return byId;
      } catch (err: any) {
        if (err?.statusCode !== 404) throw err;
      }
    }
    return this.docker.getContainer(this.containerName(server.id));
  }

  private async ensureImage(image: string) {
    const images = await this.docker.listImages({ filters: { reference: [image] } });
    if (images.length > 0) return;

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (pullErr: any) => {
          if (pullErr) return reject(pullErr);
          resolve();
        });
      });
    });
  }

  async createOrReplaceContainer(
    server: ServerRecord,
    options: {
      image: string;
      hostServerDir: string;
      workdir: string;
      cmd: string[];
      port: number;
      memoryBytes?: number;
      nanoCpus?: number;
    }
  ): Promise<string> {
    const name = this.containerName(server.id);

    try {
      const existing = this.docker.getContainer(name);
      await existing.inspect();
      await existing.remove({ force: true });
      logger.info({ name }, 'Removed existing container to recreate');
    } catch {
      // ignore missing container
    }

    await this.ensureImage(options.image);

    const container = await this.docker.createContainer({
      name,
      Image: options.image,
      WorkingDir: options.workdir,
      Cmd: options.cmd,
      ExposedPorts: {
        [`${options.port}/tcp`]: {},
      },
      HostConfig: {
        Binds: [`${options.hostServerDir}:/server`],
        PortBindings: {
          [`${options.port}/tcp`]: [{ HostPort: String(options.port) }],
        },
        Memory: options.memoryBytes,
        NanoCPUs: options.nanoCpus,
      },
    });

    return container.id;
  }

  async status(server: ServerRecord): Promise<ServerStatus> {
    try {
      const container = await this.getContainer(server);
      const inspect = await container.inspect();
      const state = inspect.State;
      if (state.Health && state.Health.Status === 'healthy') return 'running';
      if (state.Running) {
        if (server.status === 'starting' || server.status === 'restarting') {
          const ready = await this.isReady(container, server);
          return ready ? 'running' : server.status;
        }
        if (server.status === 'stopping') return 'stopping';
        return 'running';
      }
      if (state.Status === 'created' || state.Status === 'paused') return 'stopped';
      if (state.Status === 'exited' || state.Status === 'dead') {
        if (state.ExitCode === 0) return 'stopped';
        return 'exited';
      }
      return 'error';
    } catch (err: any) {
      if (err?.statusCode === 404) {
        return server.status === 'creating' ? 'creating' : 'stopped';
      }
      logger.warn({ err }, 'Unable to inspect container');
      return 'error';
    }
  }

  async start(server: ServerRecord): Promise<string> {
    const container = await this.getContainer(server);
    try {
      await container.start();
      return container.id;
    } catch (err) {
      logger.error({ err }, 'Failed to start container');
      throw err;
    }
  }

  async stop(server: ServerRecord): Promise<void> {
    const container = await this.getContainer(server);
    try {
      await container.stop({ t: 30 });
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 304 || statusCode === 404) {
        return;
      }
      try {
        await container.kill();
        return;
      } catch (killErr) {
        const killStatus = (killErr as { statusCode?: number })?.statusCode;
        if (killStatus === 304 || killStatus === 404 || killStatus === 409) {
          return;
        }
        logger.error({ err: killErr }, 'Failed to kill container after stop failure');
        throw killErr;
      }
    }
  }

  async restart(server: ServerRecord): Promise<void> {
    const container = await this.getContainer(server);
    try {
      await container.restart();
    } catch (err) {
      logger.error({ err }, 'Failed to restart container');
      throw err;
    }
  }

  async updateResources(server: ServerRecord): Promise<void> {
    const container = await this.getContainer(server);
    const memoryBytes = server.resources?.maxRamMb ? server.resources.maxRamMb * 1024 * 1024 : 0;
    const nanoCpus = server.resources?.cpuLimit ? Math.round(server.resources.cpuLimit * 1_000_000_000) : 0;
    try {
      await container.update({
        Memory: memoryBytes,
        NanoCPUs: nanoCpus,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to update container resources');
      throw err;
    }
  }

  async remove(server: ServerRecord): Promise<void> {
    try {
      const container = await this.getContainer(server);
      await container.remove({ force: true });
    } catch (err: any) {
      if (err?.statusCode === 404) {
        return;
      }
      logger.error({ err }, 'Failed to remove container');
      throw err;
    }
  }

  async logs(server: ServerRecord, opts?: { follow?: boolean }): Promise<NodeJS.ReadableStream> {
    const container = await this.getContainer(server);
    return container.logs({
      follow: opts?.follow ?? false,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: 200,
    });
  }

  async metrics(server: ServerRecord) {
    const container = await this.getContainer(server);
    const inspect = await container.inspect();
    const isRunning = inspect.State?.Running === true;
    const stats = isRunning ? await container.stats({ stream: false }) : null;

    const cpuDelta = stats?.cpu_stats?.cpu_usage?.total_usage - stats?.precpu_stats?.cpu_usage?.total_usage;
    const systemDelta = stats?.cpu_stats?.system_cpu_usage - stats?.precpu_stats?.system_cpu_usage;
    const onlineCpus = stats?.cpu_stats?.online_cpus ?? stats?.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuPercent = systemDelta && cpuDelta && systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

    const memoryBytes = stats?.memory_stats?.usage ?? 0;
    const memoryLimitBytes = stats?.memory_stats?.limit ?? 0;
    const memoryPercent = memoryLimitBytes ? (memoryBytes / memoryLimitBytes) * 100 : 0;

    let networkRxBytes = 0;
    let networkTxBytes = 0;
    const networks = stats?.networks as Record<string, { rx_bytes?: number; tx_bytes?: number }> | undefined;
    if (networks) {
      Object.values(networks).forEach((net) => {
        networkRxBytes += net.rx_bytes ?? 0;
        networkTxBytes += net.tx_bytes ?? 0;
      });
    }

    let blkReadBytes = 0;
    let blkWriteBytes = 0;
    const blk = stats?.blkio_stats?.io_service_bytes_recursive;
    if (Array.isArray(blk)) {
      blk.forEach((entry) => {
        if (entry.op === 'Read') blkReadBytes += entry.value ?? 0;
        if (entry.op === 'Write') blkWriteBytes += entry.value ?? 0;
      });
    }

    const startedAt = inspect.State?.StartedAt || null;
    const finishedAt = inspect.State?.FinishedAt || null;
    const now = Date.now();
    const startedMs = startedAt ? new Date(startedAt).getTime() : null;
    const finishedMs = finishedAt ? new Date(finishedAt).getTime() : null;
    let uptimeSeconds: number | null = null;
    if (startedMs) {
      const endMs = inspect.State?.Running ? now : finishedMs ?? now;
      uptimeSeconds = Math.max(0, Math.floor((endMs - startedMs) / 1000));
    }

    return {
      cpuPercent,
      memoryBytes,
      memoryLimitBytes,
      memoryPercent,
      networkRxBytes,
      networkTxBytes,
      blkReadBytes,
      blkWriteBytes,
      pids: stats?.pids_stats?.current ?? null,
      startedAt,
      status: inspect.State?.Status ?? null,
      exitCode: inspect.State?.ExitCode ?? null,
      uptimeSeconds,
    };
  }

  private async isReady(container: Container, server: ServerRecord): Promise<boolean> {
    let inspect: Awaited<ReturnType<Container['inspect']>> | null = null;
    try {
      inspect = await container.inspect();
    } catch (err) {
      logger.warn({ err }, 'Failed to inspect container for readiness');
    }
    const startedAt = inspect?.State?.StartedAt ? new Date(inspect.State.StartedAt).getTime() : undefined;
    try {
      const output = await this.collectLogs(container, inspect, 200, startedAt);
      if (this.hasReadySignal(output, false, startedAt)) return true;
    } catch (err) {
      logger.warn({ err }, 'Failed to scan logs for readiness');
    }
    const fileOutput = await this.collectLogFile(server, startedAt);
    if (fileOutput) {
      return this.hasReadySignal(fileOutput, true, startedAt);
    }
    return false;
  }

  private async collectLogs(
    container: Container,
    inspect: Awaited<ReturnType<Container['inspect']>> | null,
    tail: number,
    startedAt?: number
  ): Promise<string> {
    const isTty = inspect?.Config?.Tty === true;
    const since = startedAt ? Math.floor(startedAt / 1000) : undefined;
    const stream = await container.logs({ stdout: true, stderr: true, tail, since });
    return new Promise((resolve, reject) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let output = '';

      const handleData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
      };

      stdout.on('data', handleData);
      stderr.on('data', handleData);

      stream.on('error', (err) => {
        stdout.removeListener('data', handleData);
        stderr.removeListener('data', handleData);
        reject(err);
      });

      stream.on('end', () => {
        stdout.removeListener('data', handleData);
        stderr.removeListener('data', handleData);
        resolve(output);
      });

      if (isTty) {
        stream.on('data', handleData);
      } else {
        this.docker.modem.demuxStream(stream, stdout, stderr);
      }
    });
  }

  private async collectLogFile(server: ServerRecord, startedAt?: number): Promise<string | null> {
    const base = path.join(config.dataRoot, 'servers', server.id, 'pack');
    const direct = path.join(base, 'logs', 'latest.log');
    if (await pathExists(direct)) {
      const stats = await fs.stat(direct);
      if (startedAt && stats.mtimeMs < startedAt) return null;
      return this.readLogTail(direct);
    }

    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(base, entry.name, 'logs', 'latest.log');
        if (await pathExists(candidate)) {
          const stats = await fs.stat(candidate);
          if (startedAt && stats.mtimeMs < startedAt) return null;
          return this.readLogTail(candidate);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to check log file on disk');
    }
    return null;
  }

  private async readLogTail(filePath: string): Promise<string> {
    const stats = await fs.stat(filePath);
    const size = stats.size;
    const readSize = Math.min(size, 128 * 1024);
    const start = Math.max(0, size - readSize);
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private hasReadySignal(output: string, requireStartLine: boolean, startedAt?: number): boolean {
    const lines = output.split(/\r?\n/);
    let lastStartIndex = -1;
    let lastReadyIndex = -1;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      if (this.startPatterns.some((pattern) => pattern.test(line))) lastStartIndex = i;
      if (this.readyPatterns.some((pattern) => pattern.test(line))) lastReadyIndex = i;
    }

    if (lastReadyIndex === -1) return false;
    if (!requireStartLine) return true;
    if (lastStartIndex >= 0) return lastReadyIndex > lastStartIndex;

    if (startedAt) {
      const readyLine = lines[lastReadyIndex];
      const logTime = this.extractLogTime(readyLine, startedAt);
      if (logTime !== null && logTime + 2 * 60 * 1000 >= startedAt) {
        return true;
      }
    }

    return false;
  }

  private extractLogTime(line: string, startedAt: number): number | null {
    const match = line.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (!match) return null;
    const [, hh, mm, ss] = match;
    const base = new Date(startedAt);
    base.setHours(Number(hh), Number(mm), Number(ss), 0);
    return base.getTime();
  }
}

export const dockerService = new DockerService();
