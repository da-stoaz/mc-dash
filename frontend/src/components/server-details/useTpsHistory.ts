'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from '../../lib/api';
import type { ServerStatus } from '../../lib/serverTypes';

type TpsHistory = {
  state: 'available' | 'stopped' | 'unavailable' | 'unsupported';
  current: { tps: number; source: 'spark' | 'forge'; window: string } | null;
  points: { t: number; tps: number | null }[];
  sampledAt: number;
};

export function useTpsHistory(serverId: string, status: ServerStatus | null) {
  const [data, setData] = useState<TpsHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setData(null);
    setFailed(false);
    const poll = async () => {
      if (disposed) return;
      if (!document.hidden) {
        try {
          const res = await apiFetch(`${API_BASE}/servers/${serverId}/tps`, { signal: controller.signal });
          if (!res.ok) throw new Error('TPS request failed');
          const next = await res.json() as TpsHistory;
          if (!disposed) { setData(next); setFailed(false); }
        } catch {
          if (!disposed) setFailed(true);
        }
      }
      if (!disposed) { setClock(Date.now()); timer = setTimeout(poll, 10_000); }
    };
    if (status === 'running') void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [serverId, status]);

  const running = status === 'running';
  const stale = data ? clock - data.sampledAt > 30_000 : false;
  const current = running && !failed && !stale ? data?.current : null;
  return {
    visible: running && data?.state !== 'unsupported',
    points: (data?.points ?? []).filter(point => clock - point.t <= 60_000),
    current,
    unavailable: failed || stale || data?.state === 'unavailable',
  };
}
