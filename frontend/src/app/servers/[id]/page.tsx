'use client';

import { useEffect, useRef, useState } from 'react';
import {
  addToast,
  Button,
  Card,
  CardBody,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tab,
  Tabs,
} from '@heroui/react';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SettingsPanel } from '../../../components/server-details/SettingsPanel';
import { ConsoleCard } from '../../../components/server-details/ConsoleCard';
import { LifecycleToolbar } from '../../../components/server-details/LifecycleToolbar';
import { LogsCard } from '../../../components/server-details/LogsCard';
import { MetricsCard } from '../../../components/server-details/MetricsCard';
import { SnapshotsCard } from '../../../components/server-details/SnapshotsCard';
import { ServerTitle } from '../../../components/server-details/ServerTitle';
import { FailureBanner } from '../../../components/server-details/FailureBanner';
import { emptyLiveHistory, mergeLiveHistory, LiveMetricsHistory } from '../../../components/server-details/metricsUtils';
import { PlayerInfo, ServerMetrics, ServerRecord } from '../../../lib/serverTypes';
import { getApiErrorMessage } from '../../../lib/apiErrors';
import { API_BASE, apiFetch, apiOperation } from '../../../lib/api';

export default function ServerDetailsPage() {
  const params = useParams<{ id: string }>();
  const serverId = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const [server, setServer] = useState<ServerRecord | null>(null);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [players, setPlayers] = useState<PlayerInfo | null>(null);
  const [history, setHistory] = useState<LiveMetricsHistory>(emptyLiveHistory);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [confirmState, setConfirmState] = useState<null | 'stop' | 'restart' | 'deleteServer'>(null);
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
    setHistory(emptyLiveHistory());
    setMetrics(null);
    let es: EventSource | null = null;
    const prune = setInterval(() => setHistory(previous => mergeLiveHistory(previous, [])), 1000);

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
      es.addEventListener('metrics-history', (e) => {
        try {
          const samples = JSON.parse((e as MessageEvent).data);
          if (Array.isArray(samples)) setHistory(previous => mergeLiveHistory(previous, samples));
        } catch { /* ignore malformed frame */ }
      });
      es.addEventListener('metrics', (e) => {
        try {
          const sample = JSON.parse((e as MessageEvent).data);
          setMetrics(sample);
          if (sample) setHistory(previous => mergeLiveHistory(previous, [{ ...sample, at: sample.at ?? Date.now() }]));
        } catch {
          setMetrics(null);
        }
      });
      es.addEventListener('players', (e) => {
        try {
          setPlayers(JSON.parse((e as MessageEvent).data));
        } catch {
          setPlayers(null);
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
      clearInterval(prune);
      document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
    };
  }, [serverId]);

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => {
    setActionLoading((m) => ({ ...m, [id]: action }));
    try {
      const res = await apiOperation(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
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
  const hasPack = server ? Boolean(server.serverPackUrl) || Boolean(server.packReady) : false;
  const canPrepare = server ? ['stopped', 'exited', 'error'].includes(server.status) && hasPack : false;
  const canStart = server ? ['stopped', 'exited', 'error'].includes(server.status) : false;
  const canStop = server ? ['running', 'starting', 'restarting'].includes(server.status) : false;
  const canRestart = server ? server.status === 'running' : false;
  const controlsDisabled = !server || !!busy;

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
          All servers
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
          All servers
        </Button>
        <span className="muted">Server overview</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-5 rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <ServerTitle server={server} />

      <div className="flex flex-wrap items-center gap-2">
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
      </div>
      </div>

      <FailureBanner message={server.lastError} />

      <Tabs
        aria-label="Server sections"
        variant="underlined"
        size="lg"
        classNames={{
          panel: 'pt-2',
          // Phones get all five tabs spread across the width instead of a
          // horizontally scrolling strip with no visible scrollbar.
          tabList: 'max-md:w-full max-md:gap-0',
          tab: 'max-md:px-1',
          tabContent: 'max-md:text-sm',
        }}
      >
        <Tab key="overview" title="Overview">
          <div className="space-y-4">
            <MetricsCard
              serverId={serverId}
              metrics={metrics}
              players={players}
              status={server.status}
              history={history}
            />
          </div>
        </Tab>

        <Tab key="console" title="Console">
          <ConsoleCard serverId={server.id} status={server.status} exitCode={server.exitCode} playerNames={players?.names ?? []} />
        </Tab>

        <Tab key="logs" title="Logs">
          <LogsCard serverId={server.id} apiBase={API_BASE} />
        </Tab>

        <Tab key="snapshots" title="Snapshots">
          <SnapshotsCard serverId={server.id} status={server.status} onRestored={() => fetchServer()} />
        </Tab>

        <Tab key="settings" title="Settings">
          <SettingsPanel
            key={server.id}
            server={server}
            busy={Boolean(busy)}
            onUpdated={fetchServer}
            onPrepare={() => invokeAction(server.id, 'prepare')}
            onDelete={() => setConfirmState('deleteServer')}
          />
        </Tab>
      </Tabs>

      <Modal isOpen={confirmState !== null} onClose={() => setConfirmState(null)} placement="center" size="sm">
        <ModalContent>
          {(onClose) => {
            const title =
              confirmState === 'stop'
                ? 'Stop server'
                : confirmState === 'restart'
                  ? 'Restart server'
                  : 'Delete server and files';
            const tone = confirmState === 'deleteServer' ? 'danger' : 'warning';
            const description =
              confirmState === 'deleteServer'
                ? 'This permanently deletes the server and all its files, including worlds, server packs, downloads, and snapshots. This cannot be undone.'
                : 'Are you sure you want to proceed?';

            const handleConfirm = () => {
              if (!server) return;
              if (confirmState === 'stop') invokeAction(server.id, 'stop');
              if (confirmState === 'restart') invokeAction(server.id, 'restart');
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
                    {confirmState === 'deleteServer' ? 'Delete server and files' : 'Confirm'}
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
