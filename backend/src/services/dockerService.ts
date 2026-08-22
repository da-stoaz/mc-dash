import Docker, { Container } from 'dockerode';
import { PassThrough } from 'stream';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import * as tar from 'tar';
import { config } from '../config';
import { logger } from '../logger';
import { ResourceConfig, ServerRecord, ServerStatus } from '../types';
import { containerMemoryPlan } from './memoryPlan';
import { javaToolOptions } from './jvmTuning';

// Fixed in-container RCON port. We never publish it to the host: the backend
// runs with host networking and reaches each server container directly on its
// bridge IP, so a single constant port is fine across all servers.
export const RCON_PORT = 25575;

const MB = 1024 * 1024;

export type MemoryHostConfig = {
  Memory?: number;
  MemoryReservation?: number;
  MemorySwap?: number;
  MemorySwappiness?: number;
};

/**
 * The cgroup memory settings for one server.
 *
 * Three knobs, doing three different jobs:
 *
 *   Memory            hard ceiling. Sized at heap + JVM overhead, not at heap,
 *                     because everything a JVM allocates outside -Xmx still
 *                     counts against the cgroup. Capping at exactly -Xmx means
 *                     the kernel kills the server precisely when the heap fills.
 *
 *   MemoryReservation soft limit, set to the *idle* footprint. It reserves
 *                     nothing; it tells the kernel which containers to reclaim
 *                     from first when the host is under pressure. A server that
 *                     has handed heap back sits below its reservation and is
 *                     left alone, while one squatting on its peak gets pushed
 *                     back toward the floor. This is what makes "idle servers
 *                     take up less RAM" hold under contention rather than only
 *                     when nothing is competing.
 *
 *   MemorySwap        with swapMode 'off', set equal to Memory, which in cgroup
 *                     terms means zero swap for this container. A server that
 *                     blows its ceiling is then OOM-killed instead of paging.
 *                     That is the trade this whole feature exists to make: one
 *                     dead server, loudly, beats an unresponsive host — and an
 *                     unresponsive host takes SSH with it.
 */
export function memoryHostConfig(
  resources: ResourceConfig | undefined,
  swapMode: 'off' | 'limit' | 'host' = config.containerSwapMode
): MemoryHostConfig {
  const plan = containerMemoryPlan(resources);
  // No configured ceiling: leave the container unlimited rather than invent a
  // number. Docker treats 0/undefined as "no limit" and so does the ledger.
  if (!plan) return {};

  const memory = plan.capMb * MB;
  const limits: MemoryHostConfig = {
    Memory: memory,
    MemoryReservation: Math.min(plan.floorMb, plan.capMb) * MB,
  };

  if (swapMode === 'off') {
    // Docker's convention: MemorySwap is memory *plus* swap, so equal means none.
    limits.MemorySwap = memory;
  } else if (swapMode === 'limit') {
    limits.MemorySwap = memory * 2;
    limits.MemorySwappiness = 0;
  }

  return limits;
}

// Docker reports a daemon that can't do swap accounting in prose, not a code —
// and the wording differs between rootless, cgroup v1 without CONFIG_MEMCG_SWAP,
// and a v2 host with the controller disabled. Match on the shared vocabulary.
export function isSwapLimitUnsupported(err: unknown): boolean {
  const message = (err as { message?: unknown })?.message;
  if (typeof message !== 'string') return false;
  return /swap/i.test(message) && /(not supported|unsupported|no such file|cannot|capabilit)/i.test(message);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Strip the 8-byte multiplexing frame headers Docker prepends to each chunk of
// non-TTY log output. This is the buffer equivalent of modem.demuxStream, used
// when container.logs() resolves with a Buffer (no follow) instead of a stream.
function demuxDockerLogBuffer(buffer: Buffer): string {
  let output = '';
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const frameSize = buffer.readUInt32BE(offset + 4);
    offset += 8;
    output += buffer.toString('utf8', offset, offset + frameSize);
    offset += frameSize;
  }
  return output;
}

// ServerPackCreator start scripts download the modloader server jar (Fabric
// launcher, NeoForge ServerStarterJar, ...) with curl or wget on first run. Bare
// JRE images ship with neither, and installing one at container *runtime* needs
// root — which we deliberately no longer have, since containers run as the MC
// Dash user so their world files stay readable for snapshots.
//
// So we install it a phase earlier instead: `docker build` runs as the daemon
// (root) and produces an image that then runs unprivileged. Same package-manager
// cascade as before, just moved from runtime to build time.
export function derivedImageTag(base: string): string {
  // Docker repository names must be lowercase; tags allow [A-Za-z0-9_.-]. Fold
  // the whole base reference into the tag so one derived image maps to exactly
  // one base (including its tag/digest) and stale bases can't be silently reused.
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return `mc-dash/java:${slug || 'base'}`;
}

// Exits 0 immediately when the base already provides a downloader, so bases that
// ship curl cost nothing but a cache hit. Exits non-zero when no package manager
// can supply one — that failure is what lets us report the real cause instead of
// letting the pack fail later with a misleading modloader error.
export function downloaderDockerfile(base: string): string {
  return [
    `FROM ${base}`,
    // Base images that default to a non-root user would otherwise fail apt-get.
    // The runtime user is set per-container at create time, so this only affects
    // the build.
    'USER root',
    'RUN set -e; \\',
    '    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then exit 0; fi; \\',
    '    if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*; \\',
    '    elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates; \\',
    '    elif command -v microdnf >/dev/null 2>&1; then microdnf install -y curl ca-certificates; \\',
    '    elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates; \\',
    '    elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates; \\',
    '    else echo "no supported package manager to install curl/wget" >&2; exit 1; fi',
    '',
  ].join('\n');
}

// The pack would otherwise fail with something like "Fabric is not available for
// Minecraft 1.21" — true-sounding, and completely wrong. Name the actual cause.
export function downloaderUnavailableError(base: string, detail: string): Error {
  return new Error(
    `Java image "${base}" has no curl or wget, and MC Dash could not add one (${detail}). ` +
      `Server pack start scripts need a downloader to fetch the modloader jar on first run; ` +
      `without one the pack fails with a misleading error such as "Fabric is not available for ` +
      `Minecraft <version>". MC Dash adds it at image build time because containers run as the ` +
      `MC Dash user rather than root (which keeps world files readable for snapshots), so a ` +
      `runtime install is not possible. Fix: point this server's Java image — or JAVA_IMAGE — at ` +
      `a base that already includes curl, or give the Docker daemon access to your package mirrors.`
  );
}

// Decide whether a server's existing container must be recreated so it runs as
// the user MC Dash expects. Containers created before the container-user fix run
// as root and write root-owned world/log files the non-root backend can't read
// back (snapshots and readiness log reads fail with EACCES). A plain start
// reuses the old container, so without this a one-time `chown` gets clobbered the
// moment that root container next saves the world. We migrate only when:
//   - a user is actually enforced (config.containerUser is set; unset on Win dev)
//   - that user is non-root (a root backend can already read every file)
//   - the container is stopped (never yank a running server out from under itself)
//   - its current uid differs from the desired one (empty User => image default root)
export function shouldRecreateForUser(
  desired: string | undefined,
  currentUser: string | undefined,
  isRunning: boolean
): boolean {
  if (!desired || isRunning) return false;
  const desiredUid = Number(desired.split(':')[0]);
  if (!Number.isFinite(desiredUid) || desiredUid === 0) return false;
  const raw = (currentUser ?? '').trim();
  const currentUid = raw ? Number(raw.split(':')[0]) : 0;
  return !Number.isFinite(currentUid) || currentUid !== desiredUid;
}

function buildDockerClient(): Docker {
  const apiVersion = config.dockerApiVersion;
  const dockerHost = config.dockerHost?.trim();

  if (dockerHost) {
    // unix:///var/run/docker.sock or npipe:////./pipe/docker_engine -> socket path.
    // dockerode wants the bare path here, not the full URL.
    const socketMatch = dockerHost.match(/^(?:unix|npipe):\/\/(.+)$/i);
    if (socketMatch) {
      return new Docker({ socketPath: socketMatch[1], version: apiVersion });
    }

    // tcp://host:port, http(s)://host:port, or a bare host:port.
    // dockerode expects host/port/protocol separately, so parse the URL
    // instead of passing the raw string as `host` (which never connects).
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(dockerHost) ? dockerHost : `tcp://${dockerHost}`;
    const url = new URL(normalized.replace(/^tcp:\/\//i, 'http://'));
    const tlsVerify = !!config.dockerTlsVerify && config.dockerTlsVerify !== '0' && config.dockerTlsVerify.toLowerCase() !== 'false';
    const protocol = url.protocol === 'https:' || tlsVerify ? 'https' : 'http';
    const port = url.port ? Number(url.port) : protocol === 'https' ? 2376 : 2375;
    return new Docker({ host: url.hostname, port, protocol, version: apiVersion });
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

  // base image reference -> the image reference we actually run. Cleared only by
  // a restart, which is fine: the answer only changes when the base changes, and
  // a changed base means a different key.
  private readonly runnableImages = new Map<string, string>();

  /**
   * Resolve a Java image to one that can actually run a server pack — i.e. one
   * that provides curl or wget. Returns the base untouched when it already does;
   * otherwise builds (and caches) a derived image that adds one at build time.
   * Throws a message naming the real cause when neither is possible.
   */
  async ensureRunnableImage(base: string): Promise<string> {
    const cached = this.runnableImages.get(base);
    if (cached) return cached;

    await this.ensureImage(base);

    if (await this.imageHasDownloader(base)) {
      this.runnableImages.set(base, base);
      return base;
    }

    const tag = derivedImageTag(base);
    logger.info({ base, tag }, 'Java image has no downloader; building a derived image that adds one');
    await this.buildDownloaderImage(base, tag);
    this.runnableImages.set(base, tag);
    return tag;
  }

  // Probe by running `command -v` in a throwaway container rather than guessing
  // from the image name — custom and future base images may already ship curl,
  // and those should cost no build at all.
  private async imageHasDownloader(image: string): Promise<boolean> {
    let container: Container | undefined;
    try {
      container = await this.docker.createContainer({
        Image: image,
        // Override any ENTRYPOINT the base sets, or we'd probe the wrong thing.
        Entrypoint: ['/bin/sh', '-c'],
        Cmd: ['command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1'],
      });
      await container.start();
      const result = await container.wait();
      return result?.StatusCode === 0;
    } catch (err) {
      // A probe we couldn't run tells us nothing; fall through to the build,
      // whose Dockerfile performs the same check authoritatively.
      logger.warn({ err, image }, 'Could not probe image for curl/wget; assuming it needs one');
      return false;
    } finally {
      // Not AutoRemove: that races with wait() and can drop the exit status.
      await container?.remove({ force: true }).catch(() => undefined);
    }
  }

  private async buildDownloaderImage(base: string, tag: string): Promise<void> {
    const contextDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-dash-image-'));
    const log: string[] = [];
    try {
      await fs.writeFile(path.join(contextDir, 'Dockerfile'), downloaderDockerfile(base));
      const context = tar.create({ cwd: contextDir, portable: true }, ['Dockerfile']);

      const stream = await this.docker.buildImage(context as any, { t: tag, dockerfile: 'Dockerfile' });
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err: any) => (err ? reject(err) : resolve()),
          (event: any) => {
            // Docker reports a failed RUN in-band, not as a stream error.
            if (event?.error) return reject(new Error(String(event.error)));
            const chunk = typeof event?.stream === 'string' ? event.stream.trim() : '';
            if (chunk) log.push(chunk);
          }
        );
      });
    } catch (err: any) {
      const detail = [err?.message, log.slice(-5).join(' | ')].filter(Boolean).join('; ');
      throw downloaderUnavailableError(base, detail || 'image build failed');
    } finally {
      await fs.rm(contextDir, { recursive: true, force: true }).catch(() => undefined);
    }
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

    // Elastic-heap defaults for pack start scripts that build their own `java`
    // line, which our variables.txt / user_jvm_args.txt rewrites never see. The
    // JVM reads this before the command line, so a script that sets a flag
    // explicitly still wins. See jvmTuning.javaToolOptions.
    const toolOptions = javaToolOptions();

    const spec = (limits: MemoryHostConfig) => ({
      name,
      Image: options.image,
      Env: toolOptions ? [`JAVA_TOOL_OPTIONS=${toolOptions}`] : undefined,
      // Run the Minecraft process as the same user as the backend so the world
      // files it writes into the bind mount stay readable/writable by MC Dash
      // (otherwise root-owned files break snapshots/restores). undefined => use
      // the image default (root); dockerode omits undefined fields.
      User: config.containerUser,
      WorkingDir: options.workdir,
      Cmd: options.cmd,
      ExposedPorts: {
        [`${options.port}/tcp`]: {},
        [`${RCON_PORT}/tcp`]: {},
      },
      HostConfig: {
        Binds: [`${options.hostServerDir}:/server`],
        PortBindings: {
          [`${options.port}/tcp`]: [{ HostPort: String(options.port) }],
          // Publish RCON on loopback with a Docker-assigned host port, so the
          // backend can reach it via 127.0.0.1 regardless of host OS (container
          // bridge IPs aren't routable from a macOS/Docker-Desktop host). Bound
          // to 127.0.0.1 so RCON is never exposed on the LAN.
          [`${RCON_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }],
        },
        ...limits,
        NanoCPUs: options.nanoCpus,
      },
    });

    const limits = memoryHostConfig(server.resources);
    try {
      const container = await this.docker.createContainer(spec(limits));
      return container.id;
    } catch (err) {
      // Rootless Docker and kernels built without CONFIG_MEMCG_SWAP reject the
      // swap keys outright. Losing swap containment is a real downgrade — the
      // hard Memory cap and the start gate still hold, but a server over its
      // limit can now page — so it degrades loudly rather than silently, and
      // only for the keys that were refused.
      if (!isSwapLimitUnsupported(err) || limits.MemorySwap === undefined) throw err;
      const { MemorySwap, MemorySwappiness, ...withoutSwap } = limits;
      logger.warn(
        { serverId: server.id, err },
        'Docker rejected the swap limit (rootless daemon or kernel without swap accounting); ' +
          'creating the container without it. Servers can still be pushed into host swap — ' +
          'consider enabling swap accounting or removing swap from this host.'
      );
      const container = await this.docker.createContainer(spec(withoutSwap));
      return container.id;
    }
  }

  /**
   * The Docker host's own memory and CPU, as the daemon sees them. This is the
   * authority on how big the machine is: when MC Dash runs on Docker Desktop the
   * daemon lives in a VM sized quite differently from the OS running the
   * backend, and budgeting against the wrong machine is worse than not budgeting.
   */
  async hostInfo(): Promise<{ memTotalBytes: number; ncpu: number } | null> {
    try {
      const info = (await this.docker.info()) as { MemTotal?: number; NCPU?: number };
      if (!info?.MemTotal) return null;
      return { memTotalBytes: info.MemTotal, ncpu: info.NCPU ?? 0 };
    } catch (err) {
      logger.debug({ err }, 'Unable to read docker info');
      return null;
    }
  }

  /**
   * Server ids whose container is running *right now*, straight from Docker.
   *
   * The capacity ledger needs this rather than the stored status: a server the
   * DB still calls 'running' after a host reboot or a crashed container would
   * otherwise reserve memory nothing is using, and block real starts until
   * someone noticed. Returns null when Docker can't be reached, so callers can
   * fall back to stored status instead of concluding that nothing is running.
   */
  async runningServerIds(): Promise<Set<string> | null> {
    try {
      const prefix = this.containerName('');
      const containers = await this.docker.listContainers({ filters: { name: [prefix] } });
      const ids = new Set<string>();
      for (const container of containers) {
        for (const rawName of container.Names ?? []) {
          // Docker prefixes every name with '/'; the filter is a substring match,
          // so re-check the prefix rather than trusting it.
          const name = rawName.replace(/^\//, '');
          if (name.startsWith(prefix)) ids.add(name.slice(prefix.length));
        }
      }
      return ids;
    } catch (err) {
      logger.debug({ err }, 'Unable to list running containers for capacity accounting');
      return null;
    }
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

  // True when this server's existing container should be recreated to run as the
  // MC Dash user before its next start (see shouldRecreateForUser). Safe no-op
  // when there is no container yet or Docker can't be reached, so callers can
  // gate a best-effort migration on it without a try/catch of their own.
  async needsUserMigration(server: ServerRecord): Promise<boolean> {
    try {
      const container = await this.getContainer(server);
      const inspect = await container.inspect();
      return shouldRecreateForUser(config.containerUser, inspect.Config?.User, inspect.State?.Running === true);
    } catch (err: any) {
      if (err?.statusCode === 404) return false;
      logger.warn({ err }, 'Could not check container user for migration');
      return false;
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

  async stop(server: ServerRecord, opts: { timeoutSec?: number } = {}): Promise<void> {
    const container = await this.getContainer(server);
    try {
      await container.stop({ t: opts.timeoutSec ?? 30 });
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

  // Poll the container until it is no longer running, or the timeout elapses.
  // Returns true if it exited within the window (a missing container counts as
  // exited), false on timeout. Used by the graceful-stop path to wait for the
  // Minecraft JVM to save and quit on its own after an RCON `stop`.
  async waitForExit(server: ServerRecord, timeoutMs: number): Promise<boolean> {
    const container = await this.getContainer(server);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const inspect = await container.inspect();
        if (!inspect.State?.Running) return true;
      } catch (err) {
        if ((err as { statusCode?: number })?.statusCode === 404) return true;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
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

  // Resolve the RCON endpoint for a running server: its container bridge IP plus
  // the fixed RCON port. Returns null when the container isn't running or has no
  // reachable IP, so callers can fall back to restart-based config application.
  async rconAddress(server: ServerRecord): Promise<{ host: string; port: number } | null> {
    try {
      const container = await this.getContainer(server);
      const inspect = await container.inspect();
      if (!inspect.State?.Running) return null;

      const netSettings = inspect.NetworkSettings;

      // Preferred: the RCON port published to the host on loopback. Works on any
      // host OS, including macOS/Docker Desktop where container bridge IPs are
      // not routable from the host.
      const publishedRcon = netSettings?.Ports?.[`${RCON_PORT}/tcp`]?.[0]?.HostPort;
      if (publishedRcon) {
        return { host: '127.0.0.1', port: Number(publishedRcon) };
      }

      // Fallback for containers created before RCON was published: reach the
      // container's bridge IP directly (only routable when the backend shares
      // the host's network, e.g. a Linux host-networking deploy).
      let ip = netSettings?.IPAddress?.trim() ?? '';
      if (!ip && netSettings?.Networks) {
        for (const entry of Object.values(netSettings.Networks)) {
          const candidate = (entry as { IPAddress?: string })?.IPAddress?.trim();
          if (candidate) {
            ip = candidate;
            break;
          }
        }
      }
      if (!ip) return null;
      return { host: ip, port: RCON_PORT };
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      logger.warn({ err }, 'Unable to resolve RCON address');
      return null;
    }
  }

  async updateResources(server: ServerRecord): Promise<void> {
    const container = await this.getContainer(server);
    const nanoCpus = server.resources?.cpuLimit ? Math.round(server.resources.cpuLimit * 1_000_000_000) : 0;
    // MemorySwap has to move together with Memory: Docker rejects an update
    // whose new Memory exceeds the swap limit still on the cgroup, so raising a
    // server's RAM would fail if we sent Memory alone.
    const limits = memoryHostConfig(server.resources);
    try {
      await container.update({
        Memory: limits.Memory ?? 0,
        MemoryReservation: limits.MemoryReservation ?? 0,
        ...(limits.MemorySwap !== undefined ? { MemorySwap: limits.MemorySwap } : {}),
        NanoCPUs: nanoCpus,
      } as Parameters<Container['update']>[0]);
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
    // Docker's raw CPU% uses 100% = one core, so a 6-core host peaks at 600%. Normalise
    // to 0–100% of the container's CPU allocation (its cap if one is set, else host cores)
    // so CPU reads like memory: 100% = saturated. Keeps the gauge honest and stops the
    // history chart clipping off the top, so spike *width* reads as duration.
    const nanoCpus = inspect.HostConfig?.NanoCpus ?? 0;
    const quota = inspect.HostConfig?.CpuQuota ?? 0;
    const period = inspect.HostConfig?.CpuPeriod ?? 0;
    let allocatedCpus = onlineCpus;
    if (nanoCpus > 0) allocatedCpus = nanoCpus / 1e9;
    else if (quota > 0 && period > 0) allocatedCpus = quota / period;
    allocatedCpus = Math.min(allocatedCpus || onlineCpus, onlineCpus);
    const rawCpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
    const cpuPercent = allocatedCpus > 0 ? Math.min(100, rawCpuPercent / allocatedCpus) : 0;
    // Absolute cores in use (raw % is per-core: 100% = one core) alongside what's
    // available, so the UI can show "0.04 / 12 cores" — giving a bare 0% real context.
    const cpuCores = rawCpuPercent / 100;
    const cpuCoresAvailable = allocatedCpus;

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
      cpuCores,
      cpuCoresAvailable,
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
    const result = await container.logs({ stdout: true, stderr: true, tail, since });

    // Without `follow: true`, dockerode resolves with a Buffer (the whole log
    // dump) rather than a stream. Handle that directly instead of treating it
    // as a stream, which would throw "stream.on is not a function".
    if (Buffer.isBuffer(result)) {
      return isTty ? result.toString('utf8') : demuxDockerLogBuffer(result);
    }

    const stream = result as NodeJS.ReadableStream;
    return new Promise<string>((resolve, reject) => {
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
