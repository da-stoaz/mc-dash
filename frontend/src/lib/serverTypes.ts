export type ServerStatus = 'creating' | 'stopped' | 'running' | 'exited' | 'error';
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

export type ServerRecord = {
  id: string;
  name: string;
  packId?: number;
  packFileId?: number;
  packVersion?: string;
  serverPackUrl?: string;
  status: ServerStatus;
  resources: { minRamMb: number; maxRamMb: number; cpuLimit?: number };
  game: { renderDistance?: number; gameMode?: GameMode; seed?: string };
};

export type FormState = {
  name: string;
  packId: string;
  packFileId: string;
  packVersion: string;
  serverPackUrl: string;
  minRamMb: number;
  maxRamMb: number;
  cpuLimit: string;
  renderDistance: number;
  gameMode: GameMode;
  seed: string;
};

export const emptyForm: FormState = {
  name: '',
  packId: '',
  packFileId: '',
  packVersion: '',
  serverPackUrl: '',
  minRamMb: 4096,
  maxRamMb: 6144,
  cpuLimit: '',
  renderDistance: 10,
  gameMode: 'survival',
  seed: '',
};

export const statusColor: Record<ServerStatus, 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'default'> = {
  running: 'success',
  creating: 'warning',
  stopped: 'default',
  exited: 'warning',
  error: 'danger',
};

export const statusLabel: Record<ServerStatus, string> = {
  running: 'Running',
  creating: 'Preparing',
  stopped: 'Stopped',
  exited: 'Exited',
  error: 'Error',
};
