'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Input, Tooltip } from '@heroui/react';
import { CornerDownLeft, Terminal, Trash2 } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { CatalogCommand, ConsoleEntry, ServerStatus } from '../../lib/serverTypes';

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

// The commands to surface as one-click chips. Pulled from the server's catalog
// so the usage hint matches what completion would insert.
const FAVOURITES = ['list', 'give', 'tp', 'kill', 'gamemode', 'time', 'weather', 'op', 'say', 'save-all'];

// The states where RCON can plausibly answer. 'starting' is included on
// purpose: it becomes reachable partway through boot, and the backend gives a
// clear "still booting" message if it isn't yet.
const LIVE_STATES: ServerStatus[] = ['running', 'starting', 'restarting'];

const MAX_SUGGESTIONS = 6;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

export function ConsoleCard({ serverId, status, playerNames = [] }: ConsoleCardProps) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [catalog, setCatalog] = useState<CatalogCommand[]>([]);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Commands typed in this tab, newest last, walked with the arrow keys.
  const [recall, setRecall] = useState<string[]>([]);
  const [recallIndex, setRecallIndex] = useState<number | null>(null);
  // Completion is offered while typing and dismissed once something is picked,
  // so accepting a suggestion doesn't immediately re-open the list.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const live = LIVE_STATES.includes(status);

  const load = useCallback(async () => {
    try {
      const [historyRes, commandsRes] = await Promise.all([
        apiFetch(`${API_BASE}/servers/${serverId}/console`),
        apiFetch(`${API_BASE}/servers/${serverId}/console/commands`),
      ]);
      if (!historyRes.ok) throw new Error(await getApiErrorMessage(historyRes, 'Failed to load console history'));
      const data = (await historyRes.json()) as { entries: ConsoleEntry[] };
      setLines(data.entries.map((entry) => ({ kind: 'entry', entry })));
      setRecall(data.entries.map((entry) => entry.command));
      if (commandsRes.ok) {
        const payload = (await commandsRes.json()) as { commands: CatalogCommand[] };
        setCatalog(payload.commands);
      }
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

  const favourites = useMemo(
    () =>
      FAVOURITES.map((name) => catalog.find((entry) => entry.name === name)).filter(
        (entry): entry is CatalogCommand => Boolean(entry)
      ),
    [catalog]
  );

  // Only complete while the command name is still being typed — once there's a
  // space the user is on to arguments, which we can't complete.
  const suggestions = useMemo(() => {
    const typed = command.trimStart();
    if (!suggestOpen || typed.includes(' ')) return [];
    const prefix = (typed.startsWith('/') ? typed.slice(1) : typed).toLowerCase();
    if (!prefix) return [];
    const starts = catalog.filter((entry) => entry.name.startsWith(prefix));
    const contains = catalog.filter((entry) => !entry.name.startsWith(prefix) && entry.name.includes(prefix));
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [catalog, command, suggestOpen]);

  useEffect(() => {
    setSuggestIndex(0);
  }, [suggestions.length]);

  const send = async () => {
    const text = command.trim();
    if (!text || sending) return;

    setSending(true);
    setSuggestOpen(false);
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
      // A command the server didn't recognise changes what it will offer next.
      if (entry.status === 'unknown-command') load();
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

  const acceptSuggestion = (entry: CatalogCommand) => {
    // Insert the whole usage as a template: the placeholders show what the
    // command needs, and it never runs until the user replaces them and hits
    // Enter a second time.
    setCommand(entry.usage);
    setSuggestOpen(false);
    setRecallIndex(null);
    inputRef.current?.focus();
  };

  const handleValueChange = (value: string) => {
    setCommand(value);
    setSuggestOpen(true);
  };

  // While the completion list is open the arrows move through it; otherwise
  // they recall earlier commands, the way a shell behaves.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const open = suggestions.length > 0;

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setSuggestOpen(false);
      return;
    }

    if (event.key === 'Tab' && open) {
      event.preventDefault();
      acceptSuggestion(suggestions[suggestIndex]);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (open) acceptSuggestion(suggestions[suggestIndex]);
      else send();
      return;
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();

    if (open) {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setSuggestIndex((prev) => (prev + delta + suggestions.length) % suggestions.length);
      return;
    }

    if (recall.length === 0) return;

    if (event.key === 'ArrowUp') {
      const next = recallIndex === null ? recall.length - 1 : Math.max(0, recallIndex - 1);
      setRecallIndex(next);
      setCommand(recall[next]);
      setSuggestOpen(false);
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
    setSuggestOpen(false);
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
              No commands yet. Start typing to see what this server accepts, or pick one below.
            </div>
          ) : (
            lines.map((line) => {
              const at = formatTime(line.kind === 'entry' ? line.entry.at : line.at);
              const text = line.kind === 'entry' ? line.entry.command : line.command;
              const failed = line.kind === 'error' || line.entry.status !== 'ok';
              const suggestion = line.kind === 'entry' ? line.entry.suggestion : undefined;
              return (
                <div key={line.kind === 'entry' ? line.entry.id : line.id}>
                  <div className="flex gap-2">
                    <span className="text-white/30 shrink-0">{at}</span>
                    <span className={`shrink-0 ${failed ? 'text-rose-400' : 'text-primary-300'}`}>&gt;</span>
                    <span className="whitespace-pre-wrap break-all">{text}</span>
                  </div>
                  {line.kind === 'error' ? (
                    <div className="pl-4 whitespace-pre-wrap break-words text-rose-300">{line.message}</div>
                  ) : (
                    <div
                      className={`pl-4 whitespace-pre-wrap break-words ${
                        line.entry.status === 'unknown-command'
                          ? 'text-rose-300'
                          : line.entry.status === 'bad-arguments'
                            ? 'text-amber-300'
                            : 'text-white/70'
                      }`}
                    >
                      {line.entry.output || <span className="text-white/30">(no output)</span>}
                    </div>
                  )}
                  {suggestion && (
                    <button
                      type="button"
                      className="pl-4 text-primary-300 hover:underline"
                      onClick={() => insert(suggestion)}
                    >
                      Did you mean {suggestion}?
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {favourites.map((entry) => (
            <Tooltip key={entry.name} content={entry.summary} size="sm">
              <Chip size="sm" variant="flat" className="cursor-pointer" onClick={() => insert(entry.usage)}>
                {entry.name}
              </Chip>
            </Tooltip>
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

        <div className="relative">
          {suggestions.length > 0 && (
            <div className="absolute bottom-full mb-1 w-full z-20 rounded-lg border border-white/10 bg-neutral-900/95 backdrop-blur shadow-xl overflow-hidden">
              {suggestions.map((entry, index) => (
                <button
                  key={entry.name}
                  type="button"
                  // Mouse-down rather than click: the input must not lose focus
                  // before the selection is applied.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptSuggestion(entry);
                  }}
                  onMouseEnter={() => setSuggestIndex(index)}
                  className={`w-full text-left px-3 py-1.5 ${index === suggestIndex ? 'bg-white/10' : ''}`}
                >
                  <div className="font-mono text-xs">{entry.usage}</div>
                  <div className="text-[11px] muted">{entry.summary}</div>
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              ref={inputRef}
              size="sm"
              value={command}
              onValueChange={handleValueChange}
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
        </div>

        <div className="text-xs muted">
          Runs against the live server over RCON. A leading <code>/</code> is optional; ↑ and ↓ recall earlier
          commands, and Tab accepts a completion.
        </div>
      </CardBody>
    </Card>
  );
}
