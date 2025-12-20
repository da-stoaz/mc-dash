'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { Pause, Play, RefreshCw, Trash2 } from 'lucide-react';

const MAX_LOG_CHARS = 200_000;

type Props = {
  serverId: string;
  apiBase: string;
};

export function LogStream({ serverId, apiBase }: Props) {
  const [logs, setLogs] = useState('');
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!serverId || paused) return;
    const controller = new AbortController();
    let cancelled = false;

    const run = async () => {
      setConnected(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/servers/${serverId}/logs?follow=true`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Logs failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            setLogs((prev) => {
              const next = prev + chunk;
              if (next.length > MAX_LOG_CHARS) {
                return next.slice(next.length - MAX_LOG_CHARS);
              }
              return next;
            });
          }
        }
      } catch (err: any) {
        if (controller.signal.aborted) return;
        setError(err?.message ?? 'Log stream error');
        setConnected(false);
        if (!cancelled) {
          setTimeout(() => setReconnectToken((val) => val + 1), 1500);
        }
        return;
      } finally {
        if (!controller.signal.aborted) {
          setConnected(false);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase, paused, reconnectToken, serverId]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoScroll, logs]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="flat" color={connected ? 'success' : 'warning'}>
          {connected ? 'Connected' : paused ? 'Paused' : 'Disconnected'}
        </Chip>
        {error && (
          <Chip size="sm" variant="flat" color="danger">
            {error}
          </Chip>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="flat"
            startContent={paused ? <Play size={14} /> : <Pause size={14} />}
            onPress={() => setPaused((prev) => !prev)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />} onPress={() => setReconnectToken((val) => val + 1)}>
            Reconnect
          </Button>
          <Button size="sm" variant="flat" startContent={<Trash2 size={14} />} onPress={() => setLogs('')}>
            Clear
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-[420px] rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-y-auto"
      >
        {logs || 'No logs yet.'}
      </div>
    </div>
  );
}
