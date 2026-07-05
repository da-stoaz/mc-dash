'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addToast, Button } from '@heroui/react';
import { LogOut, Plus, Upload } from 'lucide-react';
import { emptyForm, FormState, ServerRecord, ServerStatus } from '../lib/serverTypes';
import { StatusBar } from '../components/StatusBar';
import { ServerTable } from '../components/ServerTable';
import { CreateModal, EditModal, ImportModal, ImportFields } from '../components/ServerModals';
import { useAuth } from '../components/AuthGate';
import { extractApiErrorMessageFromText, getApiErrorMessage } from '../lib/apiErrors';
import { API_BASE, apiFetch } from '../lib/api';

export default function Page() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showEdit, setShowEdit] = useState<ServerRecord | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [packFile, setPackFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const serversErrorRef = useRef(false);
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

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/servers`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load servers'));
      const data = await res.json();
      setServers(data);
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
          serversErrorRef.current = false;
        } catch {
          // ignore malformed frame
        }
        setLoading(false);
      });
      es.onerror = () => {
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
      const payload = new FormData();
      payload.append('file', packFile);
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
      if (form.seed) payload.append('seed', form.seed);

      const resText = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/servers`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(percent);
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            resolve(xhr.responseText);
            return;
          }
          reject(new Error(extractApiErrorMessageFromText(xhr.responseText || '', 'Create failed')));
        };
        xhr.onerror = () => reject(new Error('Create failed'));
        xhr.send(payload);
      });
      if (resText) {
        try {
          const parsed = JSON.parse(resText);
          if (parsed?.error) throw new Error(parsed.error);
        } catch {
          // Non-JSON responses are fine on success.
        }
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
      const payload = new FormData();
      payload.append('file', archive);
      payload.append('name', fields.name);
      if (fields.subdomain) payload.append('subdomain', fields.subdomain);
      payload.append('minRamMb', String(fields.minRamMb));
      payload.append('maxRamMb', String(fields.maxRamMb));
      if (fields.serverPort) payload.append('serverPort', fields.serverPort);
      if (fields.cpuLimit) payload.append('cpuLimit', fields.cpuLimit);
      if (fields.javaImage) payload.append('javaImage', fields.javaImage);

      const resText = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/servers/import`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setImportProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setImportProgress(100);
            resolve(xhr.responseText);
            return;
          }
          reject(new Error(extractApiErrorMessageFromText(xhr.responseText || '', 'Import failed')));
        };
        xhr.onerror = () => reject(new Error('Import failed'));
        xhr.send(payload);
      });
      if (resText) {
        try {
          const parsed = JSON.parse(resText);
          if (parsed?.error) throw new Error(parsed.error);
        } catch {
          // Non-JSON success responses are fine.
        }
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
            difficulty: changes.difficulty,
            seed: changes.seed,
          },
        }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Update failed'));
      const updated = await res.json().catch(() => null);
      await fetchServers();
      setShowEdit(null);
      if (updated?.restartRequired) {
        notify('Saved — restart required', 'Start or restart the server to apply these changes.', 'warning');
      } else {
        notify('Saved', 'Changes applied live — no restart needed.', 'success');
      }
    } catch (err: any) {
      notify('Update failed', err?.message ?? 'Update failed', 'danger');
    }
  };

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => {
    setActionLoading((m) => ({ ...m, [id]: action }));
    try {
      const res = await apiFetch(`${API_BASE}/servers/${id}/${action === 'prepare' ? 'prepare' : action}`, { method: 'POST' });
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

  const deleteContainer = async (id: string) => {
    setActionLoading((m) => ({ ...m, [id]: 'delete' }));
    try {
      const res = await apiFetch(`${API_BASE}/servers/${id}/container`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Delete failed'));
      await res.json().catch(() => null);
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

  return (
    <div className="min-h-screen bg-linear-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="page">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="brand text-lg">MC Dash</div>
            <div className="muted text-sm">Minecraft server manager</div>
          </div>
          <div className="flex items-center gap-2">
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

        <StatusBar counts={statusCounts} restartRequiredCount={restartRequiredCount} loading={loading} onRefresh={fetchServers} />

        <ServerTable
          servers={servers}
          actionLoading={actionLoading}
          onAction={invokeAction}
          onEdit={setShowEdit}
          onDeleteContainer={deleteContainer}
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
      <EditModal server={showEdit} onClose={() => setShowEdit(null)} onSave={handleUpdate} />
    </div>
  );
}
