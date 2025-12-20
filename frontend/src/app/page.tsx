'use client';

import { useEffect, useMemo, useState } from 'react';
import { addToast, Button } from '@heroui/react';
import { Plus } from 'lucide-react';
import { emptyForm, FormState, GameMode, ServerRecord, ServerStatus } from '../lib/serverTypes';
import { StatusBar } from '../components/StatusBar';
import { ServerTable } from '../components/ServerTable';
import { CreateModal, EditModal } from '../components/ServerModals';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export default function Page() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<ServerRecord | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });

  const notify = (title: string, description?: string, severity: 'default' | 'success' | 'warning' | 'danger' = 'default') => {
    addToast({
      title,
      description,
      severity,
      timeout: 4500,
      shouldShowTimeoutProgress: true,
    });
  };

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/servers`);
      const data = await res.json();
      setServers(data);
    } catch (err) {
      notify('Failed to load servers', undefined, 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServers();
    const interval = setInterval(fetchServers, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleCreate = async () => {
    try {
      const payload = {
        name: form.name,
        packId: form.packId ? Number(form.packId) : undefined,
        packFileId: form.packFileId ? Number(form.packFileId) : undefined,
        packVersion: form.packVersion || undefined,
        serverPackUrl: form.serverPackUrl || undefined,
        resources: {
          minRamMb: Number(form.minRamMb),
          maxRamMb: Number(form.maxRamMb),
          cpuLimit: form.cpuLimit ? Number(form.cpuLimit) : undefined,
        },
        game: {
          renderDistance: form.renderDistance ? Number(form.renderDistance) : undefined,
          gameMode: form.gameMode as GameMode,
          seed: form.seed || undefined,
        },
      };
      const res = await fetch(`${API_BASE}/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      setForm({ ...emptyForm });
      setShowCreate(false);
      await fetchServers();
      notify('Server created', 'Upload or prepare to build the container.', 'success');
    } catch (err: any) {
      notify('Create failed', err?.message ?? 'Create failed', 'danger');
    }
  };

  const handleUpdate = async (id: string, changes: Partial<FormState>) => {
    try {
      const res = await fetch(`${API_BASE}/servers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      await fetchServers();
      setShowEdit(null);
      notify('Updated', 'Changes saved. Restart if required.', 'success');
    } catch (err: any) {
      notify('Update failed', err?.message ?? 'Update failed', 'danger');
    }
  };

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => {
    setActionLoading((m) => ({ ...m, [id]: action }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `${action} failed`);
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

  const deleteContainer = async (id: string) => {
    setActionLoading((m) => ({ ...m, [id]: 'delete' }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/container`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Delete failed');
      await fetchServers();
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

  const uploadPack = async (id: string, file: File) => {
    setActionLoading((m) => ({ ...m, [id]: 'upload' }));
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/servers/${id}/upload-pack`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Upload failed');
      await fetchServers();
      notify('Upload complete', 'Server pack uploaded. Now run Prepare.', 'success');
    } catch (err: any) {
      notify('Upload failed', err?.message ?? 'Upload failed', 'danger');
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

  return (
    <div className="min-h-screen bg-linear-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="page">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="brand text-lg">MC Dash</div>
            <div className="muted text-sm">CurseForge server manager</div>
          </div>
          <Button color="primary" variant="shadow" startContent={<Plus size={16} />} onPress={() => setShowCreate(true)}>
            New server
          </Button>
        </div>

        <StatusBar counts={statusCounts} restartRequiredCount={restartRequiredCount} loading={loading} onRefresh={fetchServers} />

        <ServerTable
          servers={servers}
          actionLoading={actionLoading}
          onAction={invokeAction}
          onUpload={uploadPack}
          onEdit={setShowEdit}
          onDeleteContainer={deleteContainer}
          onDeleteServer={deleteServer}
        />
      </div>

      <CreateModal open={showCreate} onClose={() => setShowCreate(false)} form={form} setForm={setForm} onCreate={handleCreate} />
      <EditModal server={showEdit} onClose={() => setShowEdit(null)} onSave={handleUpdate} />
    </div>
  );
}
