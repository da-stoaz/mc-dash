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
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export const DIFFICULTIES: Difficulty[] = ['peaceful', 'easy', 'normal', 'hard'];

// Statuses where a server process actually exists. A config change that can't
// be applied live only needs a restart in these; anywhere else the next start
// picks it up on its own.
export function hasLiveProcess(status?: ServerStatus): boolean {
  return status === 'running' || status === 'starting' || status === 'restarting';
}

export const difficultyLabel: Record<Difficulty, string> = {
  peaceful: 'Peaceful',
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};

// Returned by GET /servers/:id/difficulty -- the modes a specific server can
// actually use plus its current value (a hardcore server is locked to Hard).
export type DifficultyOptions = {
  available: Difficulty[];
  current: Difficulty | null;
  locked: boolean;
  lockedReason?: string;
  source: 'server.properties' | 'config';
};

export type ServerRecord = {
  id: string;
  name: string;
  subdomain?: string;
  serverPackUrl?: string;
  // Original zip filename; the backend derives it from serverPackUrl.
  serverPackName?: string;
  javaImage?: string;
  effectiveJavaImage?: string;
  effectiveJavaSource?: string;
  packRecommendedJava?: string;
  packRecommendedJavaMajor?: number;
  containerId?: string;
  serverPort: number;
  whitelist?: string[];
  blacklist?: string[];
  whitelistEnabled?: boolean;
  blacklistEnabled?: boolean;
  status: ServerStatus;
  restartRequired?: boolean;
  packReady?: boolean;
  // Why the last operation failed; survives the toast and a page reload.
  lastError?: string | null;
  /** Auto-stopped for being empty; starts again when a player connects. */
  hibernated?: boolean;
  /** What the server is using right now. Null when stopped. */
  live?: {
    cpuCores: number;
    cpuPercent: number;
    memoryMb: number;
    memoryLimitMb: number;
    memoryPercent: number;
  } | null;
  /** Players online at the last RCON read; null when unknown. */
  players?: number | null;
  /** How long it has been empty, driving the "sleeps in ..." hint. */
  idleMs?: number | null;
  resources: { minRamMb: number; maxRamMb: number; cpuLimit?: number };
  game: { renderDistance?: number; gameMode?: GameMode; difficulty?: Difficulty; seed?: string };
};

export type SnapshotKind = 'manual' | 'auto-pre-restore';

export type Snapshot = {
  id: string;
  serverId: string;
  label: string | null;
  fileName: string;
  sizeBytes: number;
  kind: SnapshotKind;
  createdAt: string;
};

export type ServerMetrics = {
  cpuPercent: number;
  cpuCores: number;
  cpuCoresAvailable: number;
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

export type PlayerInfo = {
  online: number;
  max: number;
  names: string[];
};

// Whether the server actually accepted a command, read from its own answer.
export type ConsoleStatus = 'ok' | 'unknown-command' | 'bad-arguments';

// One command run through the server console, with what it printed back.
export type ConsoleEntry = {
  id: string;
  command: string;
  output: string;
  at: string;
  status: ConsoleStatus;
  /** The command it probably should have been, when the backend can guess. */
  suggestion?: string;
};

// One argument slot of a command, in the order the command takes them.
export type CommandArg = {
  /** As written in the usage, e.g. `<player>`, `[count]`, `set`. */
  label: string;
  /** Values worth offering. Empty when the argument is free-form. */
  options: string[];
  /** Fill this one from whoever is online rather than a fixed list. */
  wantsPlayer: boolean;
  optional: boolean;
};

// A command the console offers for completion. Served per server, so a
// modpack's own commands appear once the server has shown it accepts them.
export type CatalogCommand = {
  name: string;
  usage: string;
  summary: string;
  args: CommandArg[];
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
  difficulty: Difficulty;
  seed: string;
};

export type FirewallState = {
  whitelistEnabled: boolean;
  whitelist: string;
  blacklistEnabled: boolean;
  blacklist: string;
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
  difficulty: 'normal',
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
