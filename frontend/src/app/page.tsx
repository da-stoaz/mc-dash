'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

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

const statusLabels: Record<ServerStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  pending: 'Pending',
  starting: 'Starting',
  restarting: 'Restarting',
  creating: 'Creating',
  exited: 'Exited',
  error: 'Error',
};

const defaultNewServer = {
  name: '',
  packId: '',
  packFileId: '',
  packVersion: '',
  serverPackUrl: '',
  minRamMb: 2048,
  maxRamMb: 4096,
  cpuLimit: '',
  renderDistance: 10,
  gameMode: 'survival',
  seed: '',
};

export default function Page() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...defaultNewServer });

  const fetchServers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/servers`);
      const data = await res.json();
      setServers(data);
    } catch (err) {
      console.error(err);
      setMessage('Failed to load servers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServers();
  }, []);

  const submitNewServer = async (evt: FormEvent) => {
    evt.preventDefault();
    setCreating(true);
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
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text);
      }
      setForm({ ...defaultNewServer });
      await fetchServers();
      setMessage('Server added. Build/download step still required for CurseForge server pack.');
    } catch (err: any) {
      setMessage(err?.message ?? 'Failed to create server');
    } finally {
      setCreating(false);
    }
  };

  const invokeAction = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/servers/${id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Action failed');
      await fetchServers();
      setMessage(`${action} issued`);
    } catch (err: any) {
      setMessage(err?.message ?? 'Action failed');
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
    <div className="page">
      <div className="header">
        <div>
          <p className="muted">MC Dash</p>
          <h1>CurseForge server manager</h1>
        </div>
        <button onClick={fetchServers} disabled={loading}>
          Refresh
        </button>
      </div>

      {message && <div className="card muted">{message}</div>}

      <div className="panels">
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3>Servers</h3>
            <span className="muted">{loading ? 'Loading…' : `${servers.length} total`}</span>
          </div>
          <div className="server-grid">
            {servers.map((server) => (
              <ServerRow key={server.id} server={server} onAction={invokeAction} />
            ))}
            {servers.length === 0 && <div className="muted">No servers yet.</div>}
          </div>
        </div>

        <div className="card">
          <h3>Create server</h3>
          <form onSubmit={submitNewServer}>
            <label>
              Server name
              <input
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My Modded Server"
              />
            </label>
            <div className="inline-inputs">
              <label>
                CurseForge Mod ID
                <input
                  value={form.packId}
                  onChange={(e) => setForm((f) => ({ ...f, packId: e.target.value }))}
                  placeholder="e.g. 123456"
                />
              </label>
              <label>
                File ID (server pack)
                <input
                  value={form.packFileId}
                  onChange={(e) => setForm((f) => ({ ...f, packFileId: e.target.value }))}
                  placeholder="Optional"
                />
              </label>
            </div>
            <div className="inline-inputs">
              <label>
                Version label
                <input
                  value={form.packVersion}
                  onChange={(e) => setForm((f) => ({ ...f, packVersion: e.target.value }))}
                  placeholder="Optional"
                />
              </label>
              <label>
                Server pack URL (override)
                <input
                  value={form.serverPackUrl}
                  onChange={(e) => setForm((f) => ({ ...f, serverPackUrl: e.target.value }))}
                  placeholder="https://…"
                />
              </label>
            </div>

            <div className="inline-inputs">
              <label>
                Min RAM (MB)
                <input
                  type="number"
                  min={512}
                  value={form.minRamMb}
                  onChange={(e) => setForm((f) => ({ ...f, minRamMb: Number(e.target.value) }))}
                />
              </label>
              <label>
                Max RAM (MB)
                <input
                  type="number"
                  min={512}
                  value={form.maxRamMb}
                  onChange={(e) => setForm((f) => ({ ...f, maxRamMb: Number(e.target.value) }))}
                />
              </label>
              <label>
                CPU cap (cores)
                <input
                  type="number"
                  step="0.1"
                  min={0.1}
                  value={form.cpuLimit}
                  onChange={(e) => setForm((f) => ({ ...f, cpuLimit: e.target.value }))}
                />
              </label>
            </div>

            <div className="inline-inputs">
              <label>
                Render distance
                <input
                  type="number"
                  min={2}
                  max={32}
                  value={form.renderDistance}
                  onChange={(e) => setForm((f) => ({ ...f, renderDistance: Number(e.target.value) }))}
                />
              </label>
              <label>
                Game mode
                <select
                  value={form.gameMode}
                  onChange={(e) => setForm((f) => ({ ...f, gameMode: e.target.value }))}
                >
                  <option value="survival">Survival</option>
                  <option value="creative">Creative</option>
                  <option value="adventure">Adventure</option>
                  <option value="spectator">Spectator</option>
                </select>
              </label>
              <label>
                World seed
                <input
                  value={form.seed}
                  onChange={(e) => setForm((f) => ({ ...f, seed: e.target.value }))}
                  placeholder="Optional"
                />
              </label>
            </div>

            <button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Add server'}
            </button>
            <p className="muted" style={{ margin: 0 }}>
              This only records metadata. Download/build of the CurseForge server pack is still required in the backend.
            </p>
          </form>
        </div>
      </div>

      <div style={{ marginTop: 18 }} className="card">
        <h3>Status snapshot</h3>
        <div className="server-meta">
          {Object.entries(statusCounts).map(([status, count]) => (
            <span key={status} className={`status-pill status-${status}`}>
              {statusLabels[status as ServerStatus]}: {count}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ServerRow({ server, onAction }: { server: ServerRecord; onAction: (id: string, action: 'start' | 'stop' | 'restart') => void }) {
  const actionsDisabled = server.status === 'starting' || server.status === 'creating';
  return (
    <div className="server-row">
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong>{server.name}</strong>
          <span className={`status-pill status-${server.status}`}>{statusLabels[server.status]}</span>
        </div>
        <div className="server-meta">
          {server.packId && <span>Mod ID: {server.packId}</span>}
          {server.packVersion && <span>Version: {server.packVersion}</span>}
          {server.resources?.maxRamMb && <span>RAM {server.resources.minRamMb}–{server.resources.maxRamMb} MB</span>}
          {server.resources?.cpuLimit && <span>CPU cap {server.resources.cpuLimit} cores</span>}
          {server.game?.renderDistance && <span>Render distance {server.game.renderDistance}</span>}
          {server.game?.gameMode && <span>Mode: {server.game.gameMode}</span>}
        </div>
      </div>
      <div className="actions">
        <button className="secondary" disabled={actionsDisabled} onClick={() => onAction(server.id, 'stop')}>
          Stop
        </button>
        <button className="secondary" disabled={actionsDisabled} onClick={() => onAction(server.id, 'restart')}>
          Restart
        </button>
        <button disabled={actionsDisabled} onClick={() => onAction(server.id, 'start')}>
          Start
        </button>
      </div>
    </div>
  );
}
