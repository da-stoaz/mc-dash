import { ServerStatus } from './serverTypes';

/** Mirrors CapacityReport in backend/src/services/hostCapacityService.ts. */
export type HostCapacity = {
  memory: {
    totalMb: number;
    availableMb: number;
    availableKnown: boolean;
    swapTotalMb: number;
    swapUsedMb: number;
    source: 'proc' | 'docker' | 'os';
  };
  reserveMb: number;
  /** Physical memory servers may share. The guaranteed tier is checked against this. */
  budgetMb: number;
  burstRatio: number;
  burstAllowanceMb: number;
  /** Sum of live floors — reserved outright, never overcommitted. */
  guaranteedMb: number;
  /** Sum of live expected peaks — measured where there's history, configured otherwise. */
  expectedPeakMb: number;
  /** Sum of live configured ceilings — the true worst case. */
  ceilingMb: number;
  /** What running servers are using this second. Display only, never gated on. */
  actualMb: number;
  actualCpuCores: number;
  hostCpuCores: number;
  remainingGuaranteedMb: number;
  remainingBurstMb: number;
  /** ceilingMb / budgetMb. Above 1 means oversubscribed if everything peaked at once. */
  oversubscription: number;
  admissionEnabled: boolean;
  swapMode: 'off' | 'limit' | 'host';
  servers: {
    id: string;
    name: string;
    status: ServerStatus;
    live: boolean;
    maxRamMb: number;
    minRamMb: number;
    ceilingMb: number;
    floorMb: number;
    expectedPeakMb: number;
    observedPeakMb: number | null;
    observedPeakTrusted: boolean;
    actualMb: number | null;
    actualCpuCores: number | null;
    players: number | null;
    hibernated: boolean;
  }[];
  generatedAt: string;
};
