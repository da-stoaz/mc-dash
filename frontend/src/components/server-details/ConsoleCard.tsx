'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Input, Tooltip } from '@heroui/react';
import { CornerDownLeft, Terminal, Trash2 } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { ConsoleEntry, ServerStatus } from '../../lib/serverTypes';

type ConsoleCardProps = {
  serverId: string;
  status: ServerStatus;
  /** Names of players currently online, offered as one-click insertions. */
  playerNames?: string[];
};

// A line in the scrollback. Server-side entries are commands that actually ran;
// 'error' lines are local — a command that never reached the server isn't part
// of the server's history and would be misleading to replay after a reload.
type ConsoleLine =
  | { kind: 'entry'; entry: ConsoleEntry }
  | { kind: 'error'; id: string; command: string; message: string; at: string };

// Templates rather than ready-to-run commands: `give` and `tp` need arguments,
// so clicking one puts you at the start of typing instead of firing something
// half-formed at the server.
const SNIPPETS: { label: string; insert: string }[] = [
  { label: 'list', insert: 'list' },
  { label: 'give', insert: 'give <player> minecraft:diamond 1' },
  { label: 'tp', insert: 'tp <player> <x> <y> <z>' },
  { label: 'kill', insert: 'kill <target>' },
  { label: 'gamemode', insert: 'gamemode creative <player>' },
  { label: 'time', insert: 'time set day' },
  { label: 'weather', insert: 'weather clear' },
  { label: 'op', insert: 'op <player>' },
  { label: 'say', insert: 'say <message>' },
  { label: 'save-all', insert: 'save-all' },
];

// The states where RCON can plausibly answer. 'starting' is included on
// purpose: it becomes reachable partway through boot, and the backend gives a
// clear "still booting" message if it isn't yet.
const LIVE_STATES: ServerStatus[] = ['running', 'starting', 'restarting'];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

export function ConsoleCard({ serverId, status, playerNames = [] }: ConsoleCardProps) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Commands typed in this tab, newest last, walked with the arrow keys.
  const [recall, setRecall] = useState<string[]>([]);
  const [recallIndex, setRecallIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const live = LIVE_STATES.includes(status);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/console`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load console history'));
      const data = (await res.json()) as { entries: ConsoleEntry[] };
      setLines(data.entries.map((entry) => ({ kind: 'entry', entry })));
      setRecall(data.entries.map((entry) => entry.command));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  // Pin to the newest line whenever one lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const send = async () => {
    const text = command.trim();
    if (!text || sending) return;

    setSending(true);
    setRecall((prev) => (prev[prev.length - 1] === text ? prev : [...prev, text]));
    setRecallIndex(null);
    setCommand('');

    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/console`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Command failed'));
      const entry = (await res.json()) as ConsoleEntry;
      setLines((prev) => [...prev, { kind: 'entry', entry }]);
    } catch (err) {
      setLines((prev) => [
        ...prev,
        {
          kind: 'error',
          id: `err-${Date.now()}`,
          command: text,
          message: (err as Error).message,
          at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // Up/Down walk previously sent commands; Down past the newest returns to the
  // empty prompt, the way a shell behaves.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (recall.length === 0) return;
    event.preventDefault();

    if (event.key === 'ArrowUp') {
      const next = recallIndex === null ? recall.length - 1 : Math.max(0, recallIndex - 1);
      setRecallIndex(next);
      setCommand(recall[next]);
      return;
    }

    if (recallIndex === null) return;
    const next = recallIndex + 1;
    if (next >= recall.length) {
      setRecallIndex(null);
      setCommand('');
      return;
    }
    setRecallIndex(next);
    setCommand(recall[next]);
  };

  const insert = (text: string) => {
    setCommand(text);
    setRecallIndex(null);
    inputRef.current?.focus();
  };

  const clear = async () => {
    setLines([]);
    try {
      await apiFetch(`${API_BASE}/servers/${serverId}/console`, { method: 'DELETE' });
    } catch {
      // The visible scrollback is already cleared; a failed server-side clear
      // only means it comes back on the next load.
    }
  };

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Terminal size={18} />
          Console
        </div>
        <Chip size="sm" variant="flat" color={live ? 'success' : 'default'}>
          {live ? 'Connected via RCON' : 'Server not running'}
        </Chip>
        {loadError && (
          <Chip size="sm" variant="flat" color="danger">
            {loadError}
          </Chip>
        )}
        <Button
          size="sm"
          variant="flat"
          className="ml-auto"
          startContent={<Trash2 size={14} />}
          onPress={clear}
          isDisabled={lines.length === 0}
        >
          Clear
        </Button>
      </CardHeader>

      <CardBody className="space-y-3">
        <div
          ref={scrollRef}
          className="h-[45dvh] sm:h-[360px] rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-xs leading-relaxed overflow-y-auto space-y-2"
        >
          {lines.length === 0 ? (
            <div className="muted">
              No commands yet. Try <span className="text-white/70">list</span>, or pick a template below.
            </div>
          ) : (
            lines.map((line) => {
              const at = formatTime(line.kind === 'entry' ? line.entry.at : line.at);
              const text = line.kind === 'entry' ? line.entry.command : line.command;
              return (
                <div key={line.kind === 'entry' ? line.entry.id : line.id}>
                  <div className="flex gap-2">
                    <span className="text-white/30 shrink-0">{at}</span>
                    <span className="text-primary-300 shrink-0">&gt;</span>
                    <span className="whitespace-pre-wrap break-all">{text}</span>
                  </div>
                  {line.kind === 'entry' ? (
                    <div className="pl-4 whitespace-pre-wrap break-words text-white/70">
                      {line.entry.output || <span className="text-white/30">(no output)</span>}
                    </div>
                  ) : (
                    <div className="pl-4 whitespace-pre-wrap break-words text-rose-300">{line.message}</div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SNIPPETS.map((snippet) => (
            <Chip
              key={snippet.label}
              size="sm"
              variant="flat"
              className="cursor-pointer"
              onClick={() => insert(snippet.insert)}
            >
              {snippet.label}
            </Chip>
          ))}
        </div>

        {playerNames.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs muted">Online:</span>
            {playerNames.map((name) => (
              <Tooltip key={name} content="Append to the command" size="sm">
                <Chip
                  size="sm"
                  variant="flat"
                  color="success"
                  className="cursor-pointer"
                  onClick={() => insert(`${command.trimEnd()} ${name}`.trim())}
                >
                  {name}
                </Chip>
              </Tooltip>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            ref={inputRef}
            size="sm"
            value={command}
            onValueChange={setCommand}
            onKeyDown={handleKeyDown}
            placeholder={live ? 'give Alice minecraft:diamond 64' : 'Start the server to run commands'}
            isDisabled={!live || sending}
            autoComplete="off"
            spellCheck="false"
            classNames={{ input: 'font-mono' }}
            startContent={<span className="text-white/30 font-mono text-sm">&gt;</span>}
          />
          <Button
            size="sm"
            color="primary"
            endContent={<CornerDownLeft size={14} />}
            onPress={send}
            isLoading={sending}
            isDisabled={!live || !command.trim()}
          >
            Run
          </Button>
        </div>

        <div className="text-xs muted">
          Runs against the live server over RCON. A leading <code>/</code> is optional; ↑ and ↓ recall earlier commands.
        </div>
      </CardBody>
    </Card>
  );
}
