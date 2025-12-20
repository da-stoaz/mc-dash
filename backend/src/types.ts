export type ServerStatus =
  | 'creating'
  | 'stopped'
  | 'running'
  | 'exited'
  | 'error';

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

export interface ResourceConfig {
  minRamMb: number;
  maxRamMb: number;
  cpuLimit?: number; // CPU limit in cores (e.g., 0.5 == 50% of one core)
}

export interface GameConfig {
  renderDistance?: number;
  gameMode?: GameMode;
  seed?: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  packId?: number;
  packFileId?: number;
  packVersion?: string;
  serverPackUrl?: string;
  containerId?: string;
  status: ServerStatus;
  resources: ResourceConfig;
  game: GameConfig;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  restartRequired?: boolean;
}

export interface ServerCreateInput {
  name: string;
  packId?: number;
  packFileId?: number;
  packVersion?: string;
  serverPackUrl?: string;
  resources: ResourceConfig;
  game: GameConfig;
}

export interface ServerUpdateInput {
  resources?: ResourceConfig;
  game?: GameConfig;
  status?: ServerStatus;
  containerId?: string | null;
  serverPackUrl?: string;
  restartRequired?: boolean;
}
