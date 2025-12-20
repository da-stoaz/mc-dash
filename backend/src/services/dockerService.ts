import Docker, { Container } from 'dockerode';
import { config } from '../config';
import { logger } from '../logger';
import { ServerRecord, ServerStatus } from '../types';

function buildDockerClient(): Docker {
  if (config.dockerHost) {
    return new Docker({ host: config.dockerHost, version: 'v1.43' });
  }
  return new Docker({
    socketPath: config.dockerSocketPath ?? '/var/run/docker.sock',
    version: 'v1.43',
  });
}

export class DockerService {
  private docker: Docker;

  constructor() {
    this.docker = buildDockerClient();
  }

  private containerName(serverId: string) {
    return `mc-dash-${serverId}`;
  }

  private async getContainer(server: ServerRecord): Promise<Container> {
    if (server.containerId) {
      return this.docker.getContainer(server.containerId);
    }
    return this.docker.getContainer(this.containerName(server.id));
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
