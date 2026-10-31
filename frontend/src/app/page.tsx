'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addToast, Button } from '@heroui/react';
import { LogOut, Plus, Upload } from 'lucide-react';
import { emptyForm, FormState, ServerRecord, ServerStatus } from '../lib/serverTypes';
import { FilterKey, StatusBar } from '../components/StatusBar';
import { formatHostname, useRouterDomain } from '../lib/routerDomain';
import { ServerTable } from '../components/ServerTable';
import { CreateModal, ImportModal, ImportFields } from '../components/ServerModals';
import { useAuth } from '../components/AuthGate';
import { getApiErrorMessage } from '../lib/apiErrors';
import { API_BASE, apiFetch, apiOperation } from '../lib/api';
import { uploadInChunks } from '../lib/chunkedUpload';
import { Logo } from '../components/Logo';
import { CapacityBar } from '../components/CapacityBar';
import { HostCapacity } from '../lib/hostCapacity';

export default function Page() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [capacity, setCapacity] = useState<HostCapacity | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [packFile, setPackFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const serversErrorRef = useRef(false);
  // The table is fed by SSE, so the status bar reports whether that stream is
  // actually alive rather than implying the Refresh button is what keeps it current.
  const [streamLive, setStreamLive] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<FilterKey[]>([]);
  const [search, setSearch] = useState('');
  const routerDomain = useRouterDomain();
  const { authRequired, logout } = useAuth();

  const notify = (title: string, description?: string, severity: 'default' | 'success' | 'warning' | 'danger' = 'default') => {
    addToast({
      title,
      description,
      severity,
      timeout: 4500,
      shouldShowTimeoutProgress: true,
    });
  };

  // Poll the shared controller: it includes application and container memory.
  const fetchCapacity = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/host/capacity`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('Capacity unavailable');
      setCapacity(await res.json());
    } catch {
      setCapacity(null);
    }
  };

  // Signature of everything the ledger is computed from, so the refetch fires on
  // a real change rather than on every SSE frame.
  const capacitySignature = servers
    .map((server) => `${server.id}:${server.status}:${server.resources?.maxRamMb ?? 0}`)
    .join('|');

  useEffect(() => {
    void fetchCapacity();
    const timer = setInterval(() => { if (!document.hidden) void fetchCapacity(); }, 5000);
    return () => clearInterval(timer);
  }, [capacitySignature]);

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/servers`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load servers'));
      const data = await res.json();
      setServers(data);
      setLastUpdated(new Date());
      serversErrorRef.current = false;
    } catch (err) {
      if (!serversErrorRef.current) {
        notify('Failed to load servers', undefined, 'danger');
        serversErrorRef.current = true;
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let es: EventSource | null = null;

    const connect = () => {
      if (es) return;
      setLoading(true);
      es = new EventSource(`${API_BASE}/servers/stream`, { withCredentials: true });
      es.addEventListener('servers', (e) => {
        try {
          setServers(JSON.parse((e as MessageEvent).data));
          setLastUpdated(new Date());
          setStreamLive(true);
          serversErrorRef.current = false;
        } catch {
          // ignore malformed frame
        }
        setLoading(false);
      });
      es.onerror = () => {
        setStreamLive(false);
        // EventSource reconnects on its own; surface the drop only once.
        if (!serversErrorRef.current) {
          notify('Lost connection to server', 'Reconnecting…', 'warning');
          serversErrorRef.current = true;
        }
      };
    };

    const disconnect = () => {
      es?.close();
      es = null;
      setStreamLive(false);
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
  }, []);

  const handleCreate = async () => {
    if (creating) return;
    try {
      if (!packFile) {
        notify('Server pack required', 'Upload the server pack zip to continue.', 'warning');
        return;
      }

      setCreating(true);
      setUploadProgress(0);

      // The pack travels first, in slices, so no single request runs into the
      // body limit of whatever proxy sits in front. What follows is just the
      // form fields plus a reference to the assembled file.
      const uploadId = await uploadInChunks(packFile, {
        onProgress: (fraction) => setUploadProgress(Math.round(fraction * 100)),
      });

      const payload = new FormData();
      payload.append('uploadId', uploadId);
      payload.append('name', form.name);
      if (form.subdomain) payload.append('subdomain', form.subdomain);
      payload.append('minRamMb', String(form.minRamMb));
      payload.append('maxRamMb', String(form.maxRamMb));
      payload.append('gameMode', form.gameMode);
      payload.append('difficulty', form.difficulty);

      if (form.javaImage) payload.append('javaImage', form.javaImage);
      if (form.serverPort) payload.append('serverPort', form.serverPort);
      if (form.cpuLimit) payload.append('cpuLimit', form.cpuLimit);
      if (form.renderDistance) payload.append('renderDistance', String(form.renderDistance));
      payload.append('entityBroadcastRangePercentage', String(form.entityBroadcastRangePercentage));
      if (form.seed) payload.append('seed', form.seed);

      setUploadProgress(100);
      const res = await apiFetch(`${API_BASE}/servers`, { method: 'POST', body: payload });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res, 'Create failed'));
      }

      setForm({ ...emptyForm });
      setPackFile(null);
      setShowCreate(false);
      await fetchServers();
      notify('Server created', 'Server pack uploaded. Now run Prepare.', 'success');
    } catch (err: any) {
      notify('Create failed', err?.message ?? 'Create failed', 'danger');
    } finally {
      setCreating(false);
      setUploadProgress(null);
    }
  };

  const handleImport = async (fields: ImportFields, archive: File) => {
    if (importing) return;
    try {
      setImporting(true);
      setImportProgress(0);

      const uploadId = await uploadInChunks(archive, {
        onProgress: (fraction) => setImportProgress(Math.round(fraction * 100)),
      });

      const payload = new FormData();
      payload.append('uploadId', uploadId);
      payload.append('name', fields.name);
      if (fields.subdomain) payload.append('subdomain', fields.subdomain);
      payload.append('minRamMb', String(fields.minRamMb));
      payload.append('maxRamMb', String(fields.maxRamMb));
      if (fields.serverPort) payload.append('serverPort', fields.serverPort);
      if (fields.cpuLimit) payload.append('cpuLimit', fields.cpuLimit);
      if (fields.javaImage) payload.append('javaImage', fields.javaImage);

      // Import runs as a job after upload, so proxies only see short requests.
      setImportProgress(100);
      const res = await apiOperation(`${API_BASE}/servers/import`, { method: 'POST', body: payload });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res, 'Import failed'));
      }

      setShowImport(false);
      await fetchServers();
      notify('Server imported', 'Snapshot restored into a new server. It is ready to start.', 'success');
    } catch (err: any) {
      notify('Import failed', err?.message ?? 'Import failed', 'danger');
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => {
    setActionLoading((m) => ({ ...m, [id]: action }));
    try {
      const res = await apiOperation(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, `${action} failed`));
      await res.json().catch(() => null);
      await fetchServers();
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
      await fetchServers();
      notify('Server deleted', undefined, 'success');
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

  const statusCounts = useMemo(() => {
    return servers.reduce<Record<ServerStatus, number>>(
      (acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + 1;
        return acc;
      },
      {
        creating: 0,
        starting: 0,
        running: 0,
        restarting: 0,
        stopping: 0,
        stopped: 0,
        exited: 0,
        error: 0,
      }
    );
  }, [servers]);

  const restartRequiredCount = useMemo(() => servers.filter((s) => s.restartRequired).length, [servers]);

  const toggleFilter = (key: FilterKey) =>
    setStatusFilter((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // Counts above stay derived from the unfiltered list, so the chips keep
  // reporting the whole fleet rather than collapsing to whatever is on screen.
  const filteredServers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return servers.filter((server) => {
      // Several selected statuses widen the result (Error *or* Stopped); the
      // search then narrows whatever that produced.
      if (statusFilter.length > 0) {
        const matchesStatus = statusFilter.some((key) =>
          key === 'restart-required' ? Boolean(server.restartRequired) : (key === 'stopped' && server.status === 'exited') || server.status === key
        );
        if (!matchesStatus) return false;
      }
      if (!query) return true;
      const hostname = formatHostname(server.subdomain, routerDomain) ?? '';
      return [server.name, hostname, server.id].some((field) => field.toLowerCase().includes(query));
    });
  }, [servers, statusFilter, search, routerDomain]);

  const filtering = statusFilter.length > 0 || search.trim().length > 0;

  return (
    <div className="min-h-screen bg-linear-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="page">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <div className="brand text-lg">
              <Logo size={22} />
              MC Dash
            </div>
            <div className="muted text-sm">Minecraft server manager</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button color="primary" variant="shadow" startContent={<Plus size={16} />} onPress={() => setShowCreate(true)}>
              New server
            </Button>
            <Button variant="flat" startContent={<Upload size={16} />} onPress={() => setShowImport(true)}>
              Import
            </Button>
            {authRequired && (
              <Button variant="flat" startContent={<LogOut size={16} />} onPress={logout} aria-label="Log out">
                Log out
              </Button>
            )}
          </div>
        </div>

        <CapacityBar capacity={capacity} />

        <StatusBar
          counts={statusCounts}
          restartRequiredCount={restartRequiredCount}
          loading={loading}
          live={streamLive}
          lastUpdated={lastUpdated}
          onRefresh={fetchServers}
          selected={statusFilter}
          onToggleFilter={toggleFilter}
          onClearFilters={() => setStatusFilter([])}
          search={search}
          onSearchChange={setSearch}
        />

        <ServerTable
          servers={filteredServers}
          emptyContent={filtering ? 'No servers match these filters.' : 'No servers yet.'}
          actionLoading={actionLoading}
          onAction={invokeAction}
          onDeleteServer={deleteServer}
        />
      </div>

      <CreateModal
        open={showCreate}
        onClose={() => {
          if (creating) return;
          setShowCreate(false);
          setPackFile(null);
        }}
        form={form}
        setForm={setForm}
        packFile={packFile}
        setPackFile={setPackFile}
        onCreate={handleCreate}
        isCreating={creating}
        uploadProgress={uploadProgress}
      />
      <ImportModal
        open={showImport}
        onClose={() => {
          if (importing) return;
          setShowImport(false);
        }}
        onImport={handleImport}
        isImporting={importing}
        uploadProgress={importProgress}
      />
    </div>
  );
}
