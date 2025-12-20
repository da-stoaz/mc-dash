'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { emptyForm, FormState, ServerRecord, ServerStatus } from '../lib/serverTypes';
import { StatusBar } from '../components/StatusBar';
import { ServerTable } from '../components/ServerTable';
import { CreateModal, EditModal } from '../components/ServerModals';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export default function Page() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<ServerRecord | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/servers`);
      const data = await res.json();
      setServers(data);
    } catch (err) {
      setMessage('Failed to load servers');
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
    setMessage(null);
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
      setMessage('Server created. Upload or prepare to build the container.');
    } catch (err: any) {
      setMessage(err?.message ?? 'Create failed');
    }
  };

  const handleUpdate = async (id: string, changes: Partial<FormState>) => {
    setMessage(null);
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
      setMessage('Updated.');
    } catch (err: any) {
      setMessage(err?.message ?? 'Update failed');
    }
  };

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => {
    setMessage(null);
    setActionLoading((m) => ({ ...m, [id]: action }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `${action} failed`);
      await fetchServers();
      setMessage(`${action} issued`);
    } catch (err: any) {
      setMessage(err?.message ?? `${action} failed`);
    } finally {
      setActionLoading((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  };

  const deleteContainer = async (id: string) => {
    setMessage(null);
    setActionLoading((m) => ({ ...m, [id]: 'delete' }));
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/container`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Delete failed');
      await fetchServers();
      setMessage('Container deleted.');
    } catch (err: any) {
      setMessage(err?.message ?? 'Delete failed');
    } finally {
      setActionLoading((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  };

  const uploadPack = async (id: string, file: File) => {
    setMessage(null);
    setActionLoading((m) => ({ ...m, [id]: 'upload' }));
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/servers/${id}/upload-pack`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Upload failed');
      await fetchServers();
      setMessage('Server pack uploaded. Now run Prepare.');
    } catch (err: any) {
      setMessage(err?.message ?? 'Upload failed');
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
      { pending: 0, creating: 0, running: 0, stopped: 0, starting: 0, restarting: 0, exited: 0, error: 0 }
    );
  }, [servers]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="page">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="brand text-lg">MC Dash</div>
            <div className="muted text-sm">CurseForge server manager</div>
          </div>
          <Button color="primary" variant="shadow" startContent="+" onPress={() => setShowCreate(true)}>
            New server
          </Button>
        </div>

        {message && (
          <Card shadow="sm" className="mb-3 bg-primary/10 border border-primary/30">
            <CardBody>{message}</CardBody>
          </Card>
        )}

        <StatusBar counts={statusCounts} loading={loading} onRefresh={fetchServers} />

        <ServerTable
          servers={servers}
          actionLoading={actionLoading}
          onAction={invokeAction}
          onUpload={uploadPack}
          onEdit={setShowEdit}
          onDeleteContainer={deleteContainer}
        />
      </div>

      <CreateModal open={showCreate} onClose={() => setShowCreate(false)} form={form} setForm={setForm} onCreate={handleCreate} />
      <EditModal server={showEdit} onClose={() => setShowEdit(null)} onSave={handleUpdate} />
    </div>
  );
}
