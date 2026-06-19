'use client';

import { useEffect, useRef, useState } from 'react';
import {
  addToast,
  Button,
  Card,
  CardBody,
  CardHeader,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tab,
  Tabs,
} from '@heroui/react';
import { ArrowLeft, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EditModal, FirewallModal } from '../../../components/ServerModals';
import { ConfigurationCard } from '../../../components/server-details/ConfigurationCard';
import { FirewallCard } from '../../../components/server-details/FirewallCard';
import { LifecycleToolbar } from '../../../components/server-details/LifecycleToolbar';
import { LogsCard } from '../../../components/server-details/LogsCard';
import { MetricsCard } from '../../../components/server-details/MetricsCard';
import { QuickSettingsCard } from '../../../components/server-details/QuickSettingsCard';
import { ServerTitle } from '../../../components/server-details/ServerTitle';
import { clampPercent, HISTORY_LIMIT } from '../../../components/server-details/metricsUtils';
import { FirewallState, FormState, ServerMetrics, ServerRecord } from '../../../lib/serverTypes';
import { getApiErrorMessage } from '../../../lib/apiErrors';
import { API_BASE, apiFetch } from '../../../lib/api';

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
      const res = await apiFetch(`${API_BASE}/servers/${serverId}`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load server'));
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

  useEffect(() => {
    if (!serverId) return;
    let es: EventSource | null = null;

    const connect = () => {
      if (es) return;
      es = new EventSource(`${API_BASE}/servers/${serverId}/stream`, { withCredentials: true });
      es.addEventListener('server', (e) => {
        try {
          setServer(JSON.parse((e as MessageEvent).data));
          serverErrorRef.current = false;
        } catch {
          // ignore malformed frame
        }
        setLoading(false);
      });
      es.addEventListener('metrics', (e) => {
        try {
          setMetrics(JSON.parse((e as MessageEvent).data));
        } catch {
          setMetrics(null);
        }
      });
      es.onerror = () => {
        if (!serverErrorRef.current) {
          notify('Lost connection to server', 'Reconnecting…', 'warning');
          serverErrorRef.current = true;
        }
      };
    };

    const disconnect = () => {
      es?.close();
      es = null;
    };

    const onVisibility = () => {
      if (document.hidden) disconnect();
      else connect();
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
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
      const res = await apiFetch(`${API_BASE}/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          javaImage: changes.javaImage ? changes.javaImage : null,
          serverPort: changes.serverPort ? Number(changes.serverPort) : undefined,
          subdomain: changes.subdomain ? changes.subdomain : undefined,
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
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Update failed'));
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
      const res = await apiFetch(`${API_BASE}/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whitelistEnabled: changes.whitelistEnabled,
          blacklistEnabled: changes.blacklistEnabled,
          whitelist: toList(changes.whitelist),
          blacklist: toList(changes.blacklist),
        }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Update failed'));
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
      const res = await apiFetch(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, `${action} failed`));
      await res.json().catch(() => null);
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
      const res = await apiFetch(`${API_BASE}/servers/${id}/container`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Delete failed'));
      await res.json().catch(() => null);
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
      const res = await apiFetch(`${API_BASE}/servers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Delete failed'));
      await res.json().catch(() => null);
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

  const busy = server ? actionLoading[server.id] : undefined;
  const hasPack = server ? Boolean(server.serverPackUrl) : false;
  const canPrepare = server ? ['stopped', 'exited', 'error'].includes(server.status) && hasPack : false;
  const canStart = server ? ['stopped', 'exited', 'error'].includes(server.status) : false;
  const canStop = server ? ['running', 'starting', 'restarting'].includes(server.status) : false;
  const canRestart = server ? server.status === 'running' : false;
  const controlsDisabled = !server || !!busy;
  const whitelistCount = server?.whitelist?.length ?? 0;
  const blacklistCount = server?.blacklist?.length ?? 0;
  const whitelistEnabled = server?.whitelistEnabled ?? whitelistCount > 0;
  const blacklistEnabled = server?.blacklistEnabled ?? blacklistCount > 0;

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

      <ServerTitle server={server} />

      <LifecycleToolbar
        busy={busy}
        canPrepare={canPrepare}
        canStart={canStart}
        canStop={canStop}
        canRestart={canRestart}
        controlsDisabled={controlsDisabled}
        hasContainer={Boolean(server.containerId)}
        onPrepare={() => invokeAction(server.id, 'prepare')}
        onStart={() => invokeAction(server.id, 'start')}
        onStop={() => setConfirmState('stop')}
        onRestart={() => setConfirmState('restart')}
      />

      <Tabs aria-label="Server sections" variant="underlined" size="lg" classNames={{ panel: 'pt-2' }}>
        <Tab key="overview" title="Overview">
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1.1fr]">
            <MetricsCard metrics={metrics} history={history} />
            <QuickSettingsCard server={server} onEdit={() => setShowEdit(server)} />
          </div>
        </Tab>

        <Tab key="logs" title="Logs">
          <LogsCard serverId={server.id} apiBase={API_BASE} />
        </Tab>

        <Tab key="settings" title="Settings">
          <div className="space-y-4">
            <ConfigurationCard server={server} onEdit={() => setShowEdit(server)} />

            <FirewallCard
              whitelistEnabled={whitelistEnabled}
              whitelistCount={whitelistCount}
              blacklistEnabled={blacklistEnabled}
              blacklistCount={blacklistCount}
              onManage={() => setShowFirewall(server)}
            />

            <Card className="bg-rose-500/5 border border-rose-500/30">
              <CardHeader className="flex flex-col items-start gap-0.5">
                <div className="text-lg font-semibold text-rose-100">Danger zone</div>
                <div className="text-xs muted">Destructive actions for this server. World data stays on disk.</div>
              </CardHeader>
              <CardBody className="flex flex-col gap-2 sm:flex-row">
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  startContent={<Trash2 size={14} />}
                  onPress={() => setConfirmState('deleteContainer')}
                  isDisabled={controlsDisabled || busy === 'delete'}
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
                >
                  Delete server
                </Button>
              </CardBody>
            </Card>
          </div>
        </Tab>
      </Tabs>

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
