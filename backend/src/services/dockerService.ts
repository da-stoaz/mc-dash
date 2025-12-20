import Docker, { Container } from 'dockerode';
import { config } from '../config';
import { logger } from '../logger';
import { ServerRecord, ServerStatus } from '../types';

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

  constructor() {
    this.docker = buildDockerClient();
  }

  containerName(serverId: string) {
    return `mc-dash-${serverId}`;
  }

  private async getContainer(server: ServerRecord): Promise<Container> {
    if (server.containerId) {
      return this.docker.getContainer(server.containerId);
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
      if (state.Running) return 'running';
      if (state.Status === 'created' || state.Status === 'created') return 'stopped';
      if (state.Status === 'exited') return 'exited';
      return 'error';
    } catch (err) {
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
      await container.stop();
    } catch (err) {
      logger.error({ err }, 'Failed to stop container');
      throw err;
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
    } catch (err) {
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
}

export const dockerService = new DockerService();
