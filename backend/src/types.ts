export type ServerStatus =
  | 'creating'
  | 'stopped'
  | 'running'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'exited'
  | 'error';

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export interface ResourceConfig {
  minRamMb: number;
  maxRamMb: number;
  cpuLimit?: number; // CPU limit in cores (e.g., 0.5 == 50% of one core)
}

export interface GameConfig {
  renderDistance?: number;
  gameMode?: GameMode;
  difficulty?: Difficulty;
  seed?: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  subdomain?: string;
  serverPackUrl?: string;
  // Original zip filename, recovered from serverPackUrl's on-disk name. Derived,
  // not stored — see packDisplayName in serverStore.ts.
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
  resources: ResourceConfig;
  game: GameConfig;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  restartRequired?: boolean;
  packReady?: boolean;
  // Why the last operation failed, kept so a server sitting in 'error' can say
  // what happened. A toast is gone in seconds and says nothing after a reload,
  // which left the red status chip as the only trace of a failed Prepare.
  lastError?: string | null;
}

export interface ServerCreateInput {
  name: string;
  subdomain?: string;
  javaImage?: string;
  serverPort?: number;
  whitelist?: string[];
  blacklist?: string[];
  whitelistEnabled?: boolean;
  blacklistEnabled?: boolean;
  resources: ResourceConfig;
  game: GameConfig;
}

export interface ServerUpdateInput {
  name?: string;
  resources?: ResourceConfig;
  game?: GameConfig;
  status?: ServerStatus;
  containerId?: string | null;
  serverPackUrl?: string;
  javaImage?: string | null;
  effectiveJavaImage?: string | null;
  effectiveJavaSource?: string | null;
  packRecommendedJava?: string | null;
  packRecommendedJavaMajor?: number | null;
  serverPort?: number;
  subdomain?: string | null;
  whitelist?: string[];
  blacklist?: string[];
  whitelistEnabled?: boolean;
  blacklistEnabled?: boolean;
  restartRequired?: boolean;
  packReady?: boolean;
  lastError?: string | null;
}

export type SnapshotKind = 'manual' | 'auto-pre-restore';

export interface SnapshotRecord {
  id: string;
  serverId: string;
  label: string | null;
  fileName: string;
  sizeBytes: number;
  kind: SnapshotKind;
  createdAt: string;
}

export interface SnapshotCreateInput {
  serverId: string;
  label?: string | null;
  fileName: string;
  sizeBytes: number;
  kind: SnapshotKind;
}
