'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectItem,
  Spacer,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Tooltip,
} from '@heroui/react';

type ServerStatus = 'pending' | 'creating' | 'stopped' | 'running' | 'starting' | 'restarting' | 'exited' | 'error';
type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';

type ServerRecord = {
  id: string;
  name: string;
  packId?: number;
  packFileId?: number;
  packVersion?: string;
  serverPackUrl?: string;
  status: ServerStatus;
  resources: { minRamMb: number; maxRamMb: number; cpuLimit?: number };
  game: { renderDistance?: number; gameMode?: GameMode; seed?: string };
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

const statusColor: Record<ServerStatus, 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'default'> = {
  running: 'success',
  starting: 'primary',
  restarting: 'secondary',
  creating: 'warning',
  pending: 'default',
  stopped: 'default',
  exited: 'warning',
  error: 'danger',
};

const statusLabel: Record<ServerStatus, string> = {
  running: 'Running',
  starting: 'Starting',
  restarting: 'Restarting',
  creating: 'Preparing',
  pending: 'Pending',
  stopped: 'Stopped',
  exited: 'Exited',
  error: 'Error',
};

type FormState = {
  name: string;
  packId: string;
  packFileId: string;
  packVersion: string;
  serverPackUrl: string;
  minRamMb: number;
  maxRamMb: number;
  cpuLimit: string;
  renderDistance: number;
  gameMode: GameMode;
  seed: string;
};

const emptyForm: FormState = {
  name: '',
  packId: '',
  packFileId: '',
  packVersion: '',
  serverPackUrl: '',
  minRamMb: 4096,
  maxRamMb: 6144,
  cpuLimit: '',
  renderDistance: 10,
  gameMode: 'survival',
  seed: '',
};

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
          <Button color="primary" variant="shadow" startContent="+"
            onPress={() => setShowCreate(true)}>
            New server
          </Button>
        </div>

        {message && (
          <Card shadow="sm" className="mb-3 bg-primary/10 border border-primary/30">
            <CardBody>{message}</CardBody>
          </Card>
        )}

        <Card shadow="sm" className="mb-4 bg-white/5 border border-white/10">
          <CardBody className="flex flex-wrap items-center gap-2">
            {Object.entries(statusCounts).map(([status, count]) => (
              <Chip key={status} color={statusColor[status as ServerStatus]} variant="flat">
                {statusLabel[status as ServerStatus]}: {count}
              </Chip>
            ))}
            <Spacer x={1} />
            <Button size="sm" variant="flat" onPress={fetchServers} isDisabled={loading}>
              Refresh
            </Button>
          </CardBody>
        </Card>

        <Card shadow="sm" className="bg-white/5 border border-white/10">
          <Table aria-label="Servers" removeWrapper>
            <TableHeader>
              <TableColumn>Name</TableColumn>
              <TableColumn>Status</TableColumn>
              <TableColumn>Pack</TableColumn>
              <TableColumn>Resources</TableColumn>
              <TableColumn>Game</TableColumn>
              <TableColumn align="end">Actions</TableColumn>
            </TableHeader>
            <TableBody emptyContent="No servers yet." items={servers}>
              {(server) => (
                <TableRow key={server.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <strong>{server.name}</strong>
                      <span className="muted text-xs">{server.id.slice(0, 8)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Chip color={statusColor[server.status] as any} variant="flat" size="sm">
                      {statusLabel[server.status]}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 max-w-[220px]">
                      {server.packId && <span>ID {server.packId}</span>}
                      {server.packVersion && <span className="muted text-xs">v{server.packVersion}</span>}
                      {server.serverPackUrl && <span className="muted text-xs truncate">{server.serverPackUrl}</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span>{server.resources.minRamMb}–{server.resources.maxRamMb} MB</span>
                      {server.resources.cpuLimit && <span className="muted text-xs">{server.resources.cpuLimit} CPU</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {server.game.gameMode && <span>{server.game.gameMode}</span>}
                      {server.game.renderDistance && <span className="muted text-xs">{server.game.renderDistance} chunks</span>}
                      {server.game.seed && <span className="muted text-xs truncate">{server.game.seed}</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <ActionButtons
                      server={server}
                      busy={actionLoading[server.id]}
                      onAction={invokeAction}
                      onUpload={uploadPack}
                      onEdit={() => setShowEdit(server)}
                      onDeleteContainer={() => deleteContainer(server.id)}
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      <CreateModal open={showCreate} onClose={() => setShowCreate(false)} form={form} setForm={setForm} onCreate={handleCreate} />
      <EditModal server={showEdit} onClose={() => setShowEdit(null)} onSave={handleUpdate} />
    </div>
  );
}

function ActionButtons({
  server,
  busy,
  onAction,
  onUpload,
  onEdit,
  onDeleteContainer,
}: {
  server: ServerRecord;
  busy?: string;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onUpload: (id: string, file: File) => void;
  onEdit: () => void;
  onDeleteContainer: () => void;
}) {
  const disabled = !!busy || server.status === 'creating';

  const handleFile = (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (file) {
      onUpload(server.id, file);
      evt.target.value = '';
    }
  };

  return (
    <div className="flex flex-wrap gap-2 justify-end">
      <input type="file" accept=".zip" className="hidden" id={`file-${server.id}`} onChange={handleFile} />
      <Tooltip content="Upload server pack zip">
        <Button size="sm" variant="flat" onPress={() => document.getElementById(`file-${server.id}`)?.click()} isDisabled={disabled || busy === 'upload'}>
          {busy === 'upload' ? 'Uploading…' : 'Upload'}
        </Button>
      </Tooltip>
      <Button size="sm" color="warning" variant="flat" onPress={() => onAction(server.id, 'prepare')} isDisabled={disabled || busy === 'prepare'}>
        {busy === 'prepare' ? 'Preparing…' : 'Prepare'}
      </Button>
      <Button size="sm" color="success" variant="flat" onPress={() => onAction(server.id, 'start')} isDisabled={disabled || busy === 'start'}>
        {busy === 'start' ? 'Starting…' : 'Start'}
      </Button>
      <Button size="sm" variant="flat" onPress={() => onAction(server.id, 'stop')} isDisabled={disabled || busy === 'stop'}>
        {busy === 'stop' ? 'Stopping…' : 'Stop'}
      </Button>
      <Button size="sm" color="secondary" variant="flat" onPress={() => onAction(server.id, 'restart')} isDisabled={disabled || busy === 'restart'}>
        {busy === 'restart' ? 'Restarting…' : 'Restart'}
      </Button>
      <Button size="sm" variant="bordered" onPress={onEdit}>
        Edit
      </Button>
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button size="sm" color="danger" variant="flat" isDisabled={disabled || busy === 'delete'}>
            Delete
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="p-3 space-y-2 text-sm">
            <div>Delete container only?</div>
            <Button color="danger" size="sm" onPress={onDeleteContainer}>
              Delete container
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function CreateModal({
  open,
  onClose,
  form,
  setForm,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  form: FormState;
  setForm: (f: FormState) => void;
  onCreate: () => void;
}) {
  return (
    <Modal isOpen={open} onClose={onClose} placement="center">
      <ModalContent>
        {(onModalClose) => (
          <>
            <ModalHeader>Create server</ModalHeader>
            <ModalBody className="space-y-3">
              <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Divider />
              <div className="grid gap-3 md:grid-cols-2">
                <Input label="CurseForge Mod ID" value={form.packId} onChange={(e) => setForm({ ...form, packId: e.target.value })} />
                <Input label="File ID (server pack)" value={form.packFileId} onChange={(e) => setForm({ ...form, packFileId: e.target.value })} />
              </div>
              <Input label="Version label" value={form.packVersion} onChange={(e) => setForm({ ...form, packVersion: e.target.value })} />
              <Input
                label="Server pack URL or local path"
                placeholder="https://... or /path/to/pack.zip"
                value={form.serverPackUrl}
                onChange={(e) => setForm({ ...form, serverPackUrl: e.target.value })}
              />
              <Divider />
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Min RAM (MB)"
                  value={String(form.minRamMb)}
                  onChange={(e) => setForm({ ...form, minRamMb: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  label="Max RAM (MB)"
                  value={String(form.maxRamMb)}
                  onChange={(e) => setForm({ ...form, maxRamMb: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  label="CPU cap (cores)"
                  placeholder="Optional"
                  value={form.cpuLimit}
                  onChange={(e) => setForm({ ...form, cpuLimit: e.target.value })}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Render distance"
                  value={String(form.renderDistance)}
                  onChange={(e) => setForm({ ...form, renderDistance: Number(e.target.value) })}
                />
                <Select
                  label="Game mode"
                  selectedKeys={[form.gameMode]}
                  onSelectionChange={(keys) => setForm({ ...form, gameMode: Array.from(keys)[0] as GameMode })}
                >
                  <SelectItem key="survival">Survival</SelectItem>
                  <SelectItem key="creative">Creative</SelectItem>
                  <SelectItem key="adventure">Adventure</SelectItem>
                  <SelectItem key="spectator">Spectator</SelectItem>
                </Select>
                <Input label="World seed" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onModalClose}>
                Cancel
              </Button>
              <Button color="primary" onPress={onCreate}>
                Create
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

function EditModal({
  server,
  onClose,
  onSave,
}: {
  server: ServerRecord | null;
  onClose: () => void;
  onSave: (id: string, changes: Partial<FormState>) => void;
}) {
  const [local, setLocal] = useState<FormState | null>(null);

  useEffect(() => {
    if (server) {
      setLocal({
        name: server.name,
        packId: String(server.packId ?? ''),
        packFileId: String(server.packFileId ?? ''),
        packVersion: server.packVersion ?? '',
        serverPackUrl: server.serverPackUrl ?? '',
        minRamMb: server.resources.minRamMb ?? 4096,
        maxRamMb: server.resources.maxRamMb ?? 6144,
        cpuLimit: server.resources.cpuLimit?.toString() ?? '',
        renderDistance: server.game.renderDistance ?? 10,
        gameMode: server.game.gameMode ?? 'survival',
        seed: server.game.seed ?? '',
      });
    } else {
      setLocal(null);
    }
  }, [server]);

  if (!server || !local) return null;

  return (
    <Modal isOpen onClose={onClose} placement="center">
      <ModalContent>
        {(onModalClose) => (
          <>
            <ModalHeader>Edit {server.name}</ModalHeader>
            <ModalBody className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Min RAM (MB)"
                  value={String(local.minRamMb)}
                  onChange={(e) => setLocal({ ...local, minRamMb: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  label="Max RAM (MB)"
                  value={String(local.maxRamMb)}
                  onChange={(e) => setLocal({ ...local, maxRamMb: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  label="CPU cap (cores)"
                  placeholder="Optional"
                  value={local.cpuLimit}
                  onChange={(e) => setLocal({ ...local, cpuLimit: e.target.value })}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Render distance"
                  value={String(local.renderDistance)}
                  onChange={(e) => setLocal({ ...local, renderDistance: Number(e.target.value) })}
                />
                <Select
                  label="Game mode"
                  selectedKeys={[local.gameMode]}
                  onSelectionChange={(keys) => setLocal({ ...local, gameMode: Array.from(keys)[0] as GameMode })}
                >
                  <SelectItem key="survival">Survival</SelectItem>
                  <SelectItem key="creative">Creative</SelectItem>
                  <SelectItem key="adventure">Adventure</SelectItem>
                  <SelectItem key="spectator">Spectator</SelectItem>
                </Select>
                <Input label="World seed" value={local.seed} onChange={(e) => setLocal({ ...local, seed: e.target.value })} />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onModalClose}>
                Cancel
              </Button>
              <Button
                color="primary"
                onPress={() => {
                  onSave(server.id, local);
                  onModalClose();
                }}
              >
                Save
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
