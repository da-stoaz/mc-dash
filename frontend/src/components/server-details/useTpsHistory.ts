'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from '../../lib/api';
import type { ServerStatus } from '../../lib/serverTypes';
import { HISTORY_LIMIT, retainLiveWindow } from './metricsUtils';

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
  const [history, setHistory] = useState<{ end: number; points: TpsHistory['points'] } | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setData(null);
    setFailed(false);
    setHistory(null);
    const poll = async () => {
      if (disposed) return;
      if (!document.hidden) {
        try {
          const res = await apiFetch(`${API_BASE}/servers/${serverId}/tps`, { signal: controller.signal });
          if (!res.ok) throw new Error('TPS request failed');
          const next = await res.json() as TpsHistory;
          if (!disposed) {
            setData(next);
            setFailed(false);
            // Keep the latest real reading at the right edge. Clock ticks and
            // unsuccessful samples must not open empty space ahead of it.
            const end = next.points.findLast(point => point.tps != null && Number.isFinite(point.tps) && Number.isFinite(point.t))?.t;
            if (end !== undefined) setHistory(previous => previous && end < previous.end ? previous : {
              end,
              points: retainLiveWindow(next.points.filter(point => point.t <= end), point => point.t, end),
            });
          }
        } catch {
          if (!disposed) setFailed(true);
        }
      }
      if (!disposed) { setClock(Date.now()); timer = setTimeout(poll, 5_000); }
    };
    if (status === 'running') void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [serverId, status]);

  const running = status === 'running';
  const stale = data ? clock - data.sampledAt > 30_000 : false;
  const current = running && !failed && !stale ? data?.current : null;
  return {
    visible: running && data?.state !== 'unsupported',
    points: history?.points ?? [],
    window: history ? [history.end - HISTORY_LIMIT * 1000, history.end] as [number, number] : undefined,
    current,
    unavailable: failed || stale || data?.state === 'unavailable',
  };
}
