'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addToast,
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress,
} from '@heroui/react';
import {
  ArrowLeft,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Pencil,
  Play,
  RefreshCw,
  Server,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EditModal, FirewallModal } from '../../../components/ServerModals';
import { LogStream } from '../../../components/LogStream';
import { FirewallState, FormState, ServerMetrics, ServerRecord, statusColor, statusLabel } from '../../../lib/serverTypes';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUptime(seconds?: number | null) {
  if (!seconds || seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs && parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

const HISTORY_LIMIT = 60;

function clampPercent(value?: number | null) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value as number));
}

function buildSparklinePath(values: number[], width = 100, height = 36) {
  if (values.length === 0) return '';
  const step = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / 100) * height;
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
}

function buildSparklineArea(values: number[], width = 100, height = 36) {
  const line = buildSparklinePath(values, width, height);
  if (!line) return '';
  return `${line} L ${width} ${height} L 0 ${height} Z`;
}

type SparklineProps = {
  label: string;
  values: number[];
  current?: number | null;
  stroke: string;
  fill: string;
};

function SparklineCard({ label, values, current, stroke, fill }: SparklineProps) {
  const linePath = buildSparklinePath(values);
  const areaPath = buildSparklineArea(values);
  const hasData = values.length > 1;
  const avgValue =
    values.length > 0 ? `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)}%` : '--';

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">{label}</span>
        <span className="muted">Avg {avgValue}</span>
      </div>
      <div className="mt-2 h-16">
        {hasData ? (
          <svg viewBox="0 0 100 36" className="h-full w-full" preserveAspectRatio="none">
            <path d={areaPath} fill={fill} />
            <path d={linePath} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center text-xs muted">Waiting for data</div>
        )}
      </div>
    </div>
  );
}

export default function ServerDetailsPage() {
  const params = useParams<{ id: string }>();
  const serverId = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const [server, setServer] = useState<ServerRecord | null>(null);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<{ cpu: number[]; memory: number[] }>({ cpu: [], memory: [] });
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showEdit, setShowEdit] = useState<ServerRecord | null>(null);
  const [confirmState, setConfirmState] = useState<null | 'stop' | 'restart' | 'deleteContainer' | 'deleteServer'>(null);
  const [showFirewall, setShowFirewall] = useState<ServerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const serverErrorRef = useRef(false);

  const notify = (title: string, description?: string, severity: 'default' | 'success' | 'warning' | 'danger' = 'default') => {
    addToast({
      title,
      description,
      severity,
      timeout: 4500,
      shouldShowTimeoutProgress: true,
    });
  };

  const fetchServer = async () => {
    if (!serverId) return;
    try {
      const res = await fetch(`${API_BASE}/servers/${serverId}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setServer(data);
      serverErrorRef.current = false;
    } catch (err: any) {
      if (!serverErrorRef.current) {
        notify('Failed to load server', err?.message ?? 'Failed to load server', 'danger');
        serverErrorRef.current = true;
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchMetrics = async () => {
    if (!serverId) return;
    try {
      const res = await fetch(`${API_BASE}/servers/${serverId}/metrics`);
      if (!res.ok) {
        setMetrics(null);
        return;
      }
      const data = await res.json();
      setMetrics(data);
    } catch {
      setMetrics(null);
    }
  };

  useEffect(() => {
    fetchServer();
    fetchMetrics();
    const serverInterval = setInterval(fetchServer, 1000);
    const metricsInterval = setInterval(fetchMetrics, 1000);
    return () => {
      clearInterval(serverInterval);
      clearInterval(metricsInterval);
    };
  }, [serverId]);

  useEffect(() => {
    if (!metrics) return;
    const cpu = clampPercent(metrics.cpuPercent);
    const memory = clampPercent(metrics.memoryPercent);
    setHistory((prev) => ({
      cpu: [...prev.cpu, cpu].slice(-HISTORY_LIMIT),
      memory: [...prev.memory, memory].slice(-HISTORY_LIMIT),
    }));
  }, [metrics?.cpuPercent, metrics?.memoryPercent]);

  const handleUpdate = async (id: string, changes: Partial<FormState>) => {
    try {
      const res = await fetch(`${API_BASE}/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          javaImage: changes.javaImage ? changes.javaImage : null,
          resources: {
            minRamMb: changes.minRamMb !== undefined ? Number(changes.minRamMb) : undefined,
            maxRamMb: changes.maxRamMb !== undefined ? Number(changes.maxRamMb) : undefined,
            cpuLimit: changes.cpuLimit ? Number(changes.cpuLimit) : undefined,
          },
          game: {
            renderDistance: changes.renderDistance !== undefined ? Number(changes.renderDistance) : undefined,
            gameMode: changes.gameMode,
            seed: changes.seed,
          },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchServer();
      setShowEdit(null);
      notify('Updated', 'Changes saved. Restart if required.', 'success');
    } catch (err: any) {
      notify('Update failed', err?.message ?? 'Update failed', 'danger');
    }
  };

  const handleFirewallUpdate = async (id: string, changes: FirewallState) => {
    try {
      const toList = (value: string) =>
        value
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean);
      const res = await fetch(`${API_BASE}/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whitelistEnabled: changes.whitelistEnabled,
          blacklistEnabled: changes.blacklistEnabled,
          ipBlacklistEnabled: changes.ipBlacklistEnabled,
          whitelist: toList(changes.whitelist),
          blacklist: toList(changes.blacklist),
          ipBlacklist: toList(changes.ipBlacklist),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchServer();
      setShowFirewall(null);
      notify('Firewall updated', 'Access lists saved. Restart if required.', 'success');
    } catch (err: any) {
      notify('Firewall update failed', err?.message ?? 'Update failed', 'danger');
    }
  };

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => {
    setActionLoading((m) => ({ ...m, [id]: action }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `${action} failed`);
      await fetchServer();
      notify(action.charAt(0).toUpperCase() + action.slice(1), 'Command sent.', 'success');
    } catch (err: any) {
      notify(`${action} failed`, err?.message ?? `${action} failed`, 'danger');
    } finally {
      setActionLoading((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  };

  const deleteContainer = async (id: string) => {
    setActionLoading((m) => ({ ...m, [id]: 'delete' }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/container`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Delete failed');
      await fetchServer();
      notify('Container deleted', 'World data is still on disk.', 'success');
    } catch (err: any) {
      notify('Delete failed', err?.message ?? 'Delete failed', 'danger');
    } finally {
      setActionLoading((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  };

  const deleteServer = async (id: string) => {
    setActionLoading((m) => ({ ...m, [id]: 'deleteServer' }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Delete failed');
      notify('Server deleted', undefined, 'success');
      setServer(null);
    } catch (err: any) {
      notify('Delete failed', err?.message ?? 'Delete failed', 'danger');
    } finally {
      setActionLoading((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  };

  const uptimeLabel = useMemo(() => formatUptime(metrics?.uptimeSeconds ?? null), [metrics?.uptimeSeconds]);
  const busy = server ? actionLoading[server.id] : undefined;
  const hasPack = server ? Boolean(server.serverPackUrl) : false;
  const canPrepare = server ? ['stopped', 'exited', 'error'].includes(server.status) && hasPack : false;
  const canStart = server ? ['stopped', 'exited', 'error'].includes(server.status) : false;
  const canStop = server ? ['running', 'starting', 'restarting'].includes(server.status) : false;
  const canRestart = server ? server.status === 'running' : false;
  const controlsDisabled = !server || !!busy;
  const whitelistCount = server?.whitelist?.length ?? 0;
  const blacklistCount = server?.blacklist?.length ?? 0;
  const ipBlacklistCount = server?.ipBlacklist?.length ?? 0;
  const whitelistEnabled = server?.whitelistEnabled ?? whitelistCount > 0;
  const blacklistEnabled = server?.blacklistEnabled ?? blacklistCount > 0;
  const ipBlacklistEnabled = server?.ipBlacklistEnabled ?? ipBlacklistCount > 0;

  if (loading && !server) {
    return (
      <div className="page">
        <Card className="bg-white/5 border border-white/10">
          <CardBody>Loading server...</CardBody>
        </Card>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="page space-y-4">
        <Button as={Link} href="/" variant="flat" startContent={<ArrowLeft size={16} />}>
          Back
        </Button>
        <Card className="bg-white/5 border border-white/10">
          <CardBody>Server not found.</CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="page space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button as={Link} href="/" variant="flat" startContent={<ArrowLeft size={16} />}>
          Back
        </Button>
        <span className="muted">Server details</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="text-3xl font-semibold tracking-tight">{server.name}</div>
          <div className="muted text-sm">{server.id}</div>
          <div className="flex flex-wrap gap-2">
            <Chip color={statusColor[server.status]} variant="flat" size="sm">
              {statusLabel[server.status]}
            </Chip>
            {server.restartRequired && (
              <Chip color="warning" variant="flat" size="sm">
                Restart required
              </Chip>
            )}
          </div>
        </div>
      </div>

      <Card className="bg-white/5 border border-white/10">
        <CardHeader className="flex items-center justify-between">
          <div className="text-lg font-semibold">Controls</div>
          <div className="text-xs muted">Lifecycle, config, and maintenance actions</div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Lifecycle</div>
                  <div className="text-xs muted">Prepare, start, stop, restart</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    color="warning"
                    variant="flat"
                    startContent={<Wand2 size={14} />}
                    onPress={() => invokeAction(server.id, 'prepare')}
                    isDisabled={controlsDisabled || !canPrepare}
                  >
                    {busy === 'prepare' ? 'Preparing...' : 'Prepare'}
                  </Button>
                  <Button
                    size="sm"
                    color="success"
                    variant="flat"
                    startContent={<Play size={14} />}
                    onPress={() => invokeAction(server.id, 'start')}
                    isDisabled={controlsDisabled || !canStart || !server.containerId}
                  >
                    {busy === 'start' ? 'Starting...' : 'Start'}
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<Square size={14} />}
                    onPress={() => setConfirmState('stop')}
                    isDisabled={controlsDisabled || !canStop}
                  >
                    {busy === 'stop' ? 'Stopping...' : 'Stop'}
                  </Button>
                  <Button
                    size="sm"
                    color="secondary"
                    variant="flat"
                    startContent={<RefreshCw size={14} />}
                    onPress={() => setConfirmState('restart')}
                    isDisabled={controlsDisabled || !canRestart}
                  >
                    {busy === 'restart' ? 'Restarting...' : 'Restart'}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Configuration</div>
                  <div className="text-xs muted">Resources, game rules, Java image</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="bordered" startContent={<Pencil size={14} />} onPress={() => setShowEdit(server)}>
                    Edit config
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4">
              <div className="text-sm font-semibold text-rose-100">Danger zone</div>
              <div className="text-xs muted">Destructive actions for this server</div>
              <div className="mt-3 flex flex-col gap-2">
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  startContent={<Trash2 size={14} />}
                  onPress={() => setConfirmState('deleteContainer')}
                  isDisabled={controlsDisabled || busy === 'delete'}
                  fullWidth
                >
                  Delete container
                </Button>
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  startContent={<Trash2 size={14} />}
                  onPress={() => setConfirmState('deleteServer')}
                  isDisabled={controlsDisabled || busy === 'deleteServer'}
                  fullWidth
                >
                  Delete server
                </Button>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card className="bg-white/5 border border-white/10">
        <CardHeader className="flex items-center justify-between">
          <div className="text-lg font-semibold">Firewall & access</div>
          <Button size="sm" variant="bordered" onPress={() => setShowFirewall(server)}>
            Manage firewall
          </Button>
        </CardHeader>
        <CardBody className="grid gap-4 md:grid-cols-3 text-sm">
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="text-xs uppercase tracking-wide muted">Whitelist</div>
            <div className="mt-2 text-lg font-semibold">{whitelistEnabled ? 'Enabled' : 'Disabled'}</div>
            <div className="text-xs muted">{whitelistCount} allowed</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="text-xs uppercase tracking-wide muted">Player blacklist</div>
            <div className="mt-2 text-lg font-semibold">{blacklistEnabled ? 'Enabled' : 'Disabled'}</div>
            <div className="text-xs muted">{blacklistCount} blocked</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="text-xs uppercase tracking-wide muted">IP blacklist</div>
            <div className="mt-2 text-lg font-semibold">{ipBlacklistEnabled ? 'Enabled' : 'Disabled'}</div>
            <div className="text-xs muted">{ipBlacklistCount} blocked</div>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1.4fr]">
        <Card className="bg-white/5 border border-white/10">
          <CardHeader className="flex items-center gap-2 text-lg font-semibold">
            <Server size={18} />
            <span>Configuration</span>
          </CardHeader>
          <CardBody className="space-y-4 text-sm">
            <div className="space-y-2">
              <div className="text-base font-semibold">Server pack</div>
              <div className="muted break-all">
                {server.serverPackUrl ? server.serverPackUrl.split(/[\\/]/).pop() : 'Not uploaded'}
              </div>
              <div className="muted">Java image: {server.javaImage ?? 'Auto'}</div>
              <div className="muted">Container: {server.containerId ?? '-'}</div>
            </div>
            <Divider className="bg-white/10" />
            <div className="space-y-2">
              <div className="text-base font-semibold">Resources</div>
              <div className="muted">
                RAM: {server.resources.minRamMb}-{server.resources.maxRamMb} MB
              </div>
              <div className="muted">CPU cap: {server.resources.cpuLimit ?? '-'} cores</div>
            </div>
            <Divider className="bg-white/10" />
            <div className="space-y-2">
              <div className="text-base font-semibold">Game</div>
              <div className="muted">Mode: {server.game.gameMode ?? '-'}</div>
              <div className="muted">Render distance: {server.game.renderDistance ?? '-'} chunks</div>
              <div className="muted break-all">Seed: {server.game.seed || '-'}</div>
            </div>
          </CardBody>
        </Card>

        <Card className="bg-white/5 border border-white/10">
          <CardHeader className="flex items-center gap-2 text-lg font-semibold">
            <Cpu size={18} />
            <span>Metrics</span>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="text-sm muted mb-2">CPU</div>
                <Progress size="sm" value={metrics?.cpuPercent ?? 0} showValueLabel />
              </div>
              <div>
                <div className="text-sm muted mb-2">Memory</div>
                <Progress size="sm" value={metrics?.memoryPercent ?? 0} showValueLabel />
                <div className="text-xs muted mt-1">
                  {formatBytes(metrics?.memoryBytes)} / {formatBytes(metrics?.memoryLimitBytes)}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs uppercase tracking-wide muted">
                <span>Usage history</span>
                <span className="normal-case">Last {HISTORY_LIMIT}s</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <SparklineCard
                  label="CPU usage"
                  values={history.cpu}
                  current={metrics?.cpuPercent}
                  stroke="#22d3ee"
                  fill="rgba(34, 211, 238, 0.18)"
                />
                <SparklineCard
                  label="Memory usage"
                  values={history.memory}
                  current={metrics?.memoryPercent}
                  stroke="#3b82f6"
                  fill="rgba(59, 130, 246, 0.18)"
                />
              </div>
            </div>

            <Divider className="bg-white/10" />

            <div className="grid gap-3 md:grid-cols-3 text-sm">
              <div className="flex items-start gap-2">
                <Network size={16} />
                <div>
                  <div className="font-semibold">Network</div>
                  <div className="muted">In: {formatBytes(metrics?.networkRxBytes)}</div>
                  <div className="muted">Out: {formatBytes(metrics?.networkTxBytes)}</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <HardDrive size={16} />
                <div>
                  <div className="font-semibold">Disk</div>
                  <div className="muted">Read: {formatBytes(metrics?.blkReadBytes)}</div>
                  <div className="muted">Write: {formatBytes(metrics?.blkWriteBytes)}</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <MemoryStick size={16} />
                <div>
                  <div className="font-semibold">Runtime</div>
                  <div className="muted">PIDs: {metrics?.pids ?? '-'}</div>
                  <div className="muted">Uptime: {uptimeLabel}</div>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="bg-white/5 border border-white/10">
        <CardHeader className="text-lg font-semibold">Live logs</CardHeader>
        <CardBody>
          <LogStream serverId={server.id} apiBase={API_BASE} />
        </CardBody>
      </Card>

      <EditModal server={showEdit} onClose={() => setShowEdit(null)} onSave={handleUpdate} />
      <FirewallModal server={showFirewall} onClose={() => setShowFirewall(null)} onSave={handleFirewallUpdate} />

      <Modal isOpen={confirmState !== null} onClose={() => setConfirmState(null)} placement="center" size="sm">
        <ModalContent>
          {(onClose) => {
            const title =
              confirmState === 'stop'
                ? 'Stop server'
                : confirmState === 'restart'
                  ? 'Restart server'
                  : confirmState === 'deleteServer'
                    ? 'Delete server'
                    : 'Delete container';
            const tone = confirmState === 'deleteContainer' || confirmState === 'deleteServer' ? 'danger' : 'warning';
            const description =
              confirmState === 'deleteContainer'
                ? 'This will remove the Docker container for this server. World data stays on disk.'
                : confirmState === 'deleteServer'
                  ? 'This will remove the server entry and its container. World data stays on disk.'
                  : 'Are you sure you want to proceed?';

            const handleConfirm = () => {
              if (!server) return;
              if (confirmState === 'stop') invokeAction(server.id, 'stop');
              if (confirmState === 'restart') invokeAction(server.id, 'restart');
              if (confirmState === 'deleteContainer') deleteContainer(server.id);
              if (confirmState === 'deleteServer') deleteServer(server.id);
              setConfirmState(null);
              onClose();
            };

            return (
              <>
                <ModalHeader>{title}</ModalHeader>
                <ModalBody className="text-sm">{description}</ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>
                    Cancel
                  </Button>
                  <Button color={tone} onPress={handleConfirm}>
                    Confirm
                  </Button>
                </ModalFooter>
              </>
            );
          }}
        </ModalContent>
      </Modal>
    </div>
  );
}
