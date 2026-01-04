export type ServerStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'exited'
  | 'error';
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

export type ServerRecord = {
  id: string;
  name: string;
  subdomain?: string;
  serverPackUrl?: string;
  javaImage?: string;
  effectiveJavaImage?: string;
  effectiveJavaSource?: string;
  packRecommendedJava?: string;
  packRecommendedJavaMajor?: number;
  containerId?: string;
  serverPort: number;
  whitelist?: string[];
  blacklist?: string[];
  ipBlacklist?: string[];
  whitelistEnabled?: boolean;
  blacklistEnabled?: boolean;
  ipBlacklistEnabled?: boolean;
  status: ServerStatus;
  restartRequired?: boolean;
  resources: { minRamMb: number; maxRamMb: number; cpuLimit?: number };
  game: { renderDistance?: number; gameMode?: GameMode; seed?: string };
};

export type ServerMetrics = {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blkReadBytes: number;
  blkWriteBytes: number;
  pids: number | null;
  startedAt: string | null;
  status: string | null;
  exitCode: number | null;
  uptimeSeconds: number | null;
};

export type FormState = {
  name: string;
  subdomain: string;
  javaImage: string;
  serverPort: string;
  minRamMb: number;
  maxRamMb: number;
  cpuLimit: string;
  renderDistance: number;
  gameMode: GameMode;
  seed: string;
};

export type FirewallState = {
  whitelistEnabled: boolean;
  whitelist: string;
  blacklistEnabled: boolean;
  blacklist: string;
  ipBlacklistEnabled: boolean;
  ipBlacklist: string;
};

export const emptyForm: FormState = {
  name: '',
  subdomain: '',
  javaImage: '',
  serverPort: '',
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
  starting: 'warning',
  restarting: 'secondary',
  stopping: 'warning',
  stopped: 'default',
  exited: 'warning',
  error: 'danger',
};

export const statusLabel: Record<ServerStatus, string> = {
  running: 'Running',
  creating: 'Preparing',
  starting: 'Starting',
  restarting: 'Restarting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  exited: 'Exited',
  error: 'Error',
};
