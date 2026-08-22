'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip } from '@heroui/react';
import { CornerDownLeft, Trash2 } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { CatalogCommand, ConsoleEntry, ServerStatus, statusColor, statusLabel } from '../../lib/serverTypes';

type ConsoleCardProps = {
  serverId: string;
  status: ServerStatus;
  /** Who is online, offered where a command wants a player name. */
  playerNames?: string[];
};

// A line in the scrollback. Server-side entries are commands that actually ran;
// 'error' lines are local — a command that never reached the server isn't part
// of the server's history and would be misleading to replay after a reload.
type ConsoleLine =
  | { kind: 'entry'; entry: ConsoleEntry }
  | { kind: 'error'; id: string; command: string; message: string; at: string };

type Completion = { value: string; label: string; hint: string };

const MAX_COMPLETIONS = 7;

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
  const [focused, setFocused] = useState(false);
  // Commands sent from this tab, newest last, walked with the arrow keys.
  const [recall, setRecall] = useState<string[]>([]);
  const [recallIndex, setRecallIndex] = useState<number | null>(null);
  // Completions are offered while typing and dismissed once one is taken, so
  // accepting doesn't immediately re-open the list.
  const [listOpen, setListOpen] = useState(false);
  const [listIndex, setListIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const running = status === 'running';

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

  // Where the caret is in the command: token 0 is the command name, the rest
  // are its arguments. A trailing space means the next slot has been reached.
  const tokens = useMemo(
    () => (command.startsWith('/') ? command.slice(1) : command).split(' '),
    [command]
  );
  const slot = tokens.length - 1;
  const entry = useMemo(
    () => catalog.find((item) => item.name === tokens[0]?.toLowerCase()),
    [catalog, tokens]
  );
  // The usage split into its argument placeholders, so the one being typed can
  // be picked out and shown above the prompt.
  const usageParts = useMemo(() => (entry ? entry.usage.split(' ') : []), [entry]);

  const completions = useMemo<Completion[]>(() => {
    if (!listOpen) return [];
    const prefix = (tokens[slot] ?? '').toLowerCase();

    // Still on the command name: offer commands, labelled with the whole usage
    // so the arguments each one takes are visible before it is picked.
    if (slot === 0) {
      const pool = prefix
        ? [
            ...catalog.filter((item) => item.name.startsWith(prefix)),
            ...catalog.filter((item) => !item.name.startsWith(prefix) && item.name.includes(prefix)),
          ]
        : catalog;
      return pool
        .slice(0, MAX_COMPLETIONS)
        .map((item) => ({ value: item.name, label: item.usage, hint: item.summary }));
    }

    // Past the name: the argument in this slot decides what to offer. The args
    // list lines up with the usage, so slot 1 is the first argument.
    const arg = entry?.args[slot - 1];
    if (!arg) return [];

    if (arg.wantsPlayer) {
      return playerNames
        .filter((name) => name.toLowerCase().startsWith(prefix))
        .slice(0, MAX_COMPLETIONS)
        .map((name) => ({ value: name, label: name, hint: 'online now' }));
    }

    // Item ids are remembered by their tail ("hoe"), not their head, and the
    // server prints them back with the `minecraft:` namespace people then type.
    // So match on either end, prefixes first.
    const bare = prefix.replace(/^minecraft:/, '');
    const starts = arg.options.filter((option) => option.startsWith(bare));
    const contains = arg.options.filter((option) => !option.startsWith(bare) && option.includes(bare));
    return [...starts, ...contains]
      .slice(0, MAX_COMPLETIONS)
      .map((option) => ({ value: option, label: option, hint: arg.optional ? 'optional' : '' }));
  }, [catalog, entry, listOpen, playerNames, slot, tokens]);

  useEffect(() => {
    setListIndex(0);
  }, [completions.length]);

  const send = async () => {
    const text = command.trim();
    if (!text || sending) return;

    setSending(true);
    setListOpen(false);
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
      const result = (await res.json()) as ConsoleEntry;
      setLines((prev) => [...prev, { kind: 'entry', entry: result }]);
      // A command the server didn't recognise changes what it will offer next.
      if (result.status === 'unknown-command') load();
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
      // Land back on the prompt, ready for the next command. The input is never
      // disabled while sending precisely so this can work — focus() is a no-op
      // on a disabled element, and the browser has already blurred it by then.
      inputRef.current?.focus();
      // Refocusing must not pop the whole command list open over the output
      // that just arrived; this runs after the focus handler, so it wins.
      setListOpen(false);
    }
  };

  /**
   * Swap the token being typed for the chosen one and move to the next slot.
   * Only the name goes in, never the placeholders — the usage line above the
   * prompt shows what comes next, so nothing runnable is ever a literal
   * `<target>`.
   */
  const accept = (value: string) => {
    const next = [...tokens];
    next[slot] = value;
    setCommand(`${next.join(' ')} `);
    // Stay open: the caret has moved to the next argument, so the list now
    // shows that one's values (and closes itself when it has none to show).
    setListOpen(true);
    setRecallIndex(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const open = completions.length > 0;

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setListOpen(false);
      return;
    }

    if (event.key === 'Tab' && open) {
      event.preventDefault();
      accept(completions[listIndex].value);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (open) accept(completions[listIndex].value);
      else send();
      return;
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();

    // The list owns the arrows while it is open; otherwise they walk history.
    if (open) {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setListIndex((prev) => (prev + delta + completions.length) % completions.length);
      return;
    }

    if (recall.length === 0) return;

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

  const clear = async () => {
    setLines([]);
    try {
      await apiFetch(`${API_BASE}/servers/${serverId}/console`, { method: 'DELETE' });
    } catch {
      // The visible scrollback is already cleared; a failed server-side clear
      // only means it comes back on the next load.
    }
  };

  const placeholder = running
    ? 'Type a command'
    : status === 'starting' || status === 'restarting'
      ? 'Waiting for the server to finish starting'
      : 'Start the server to run commands';

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center gap-2">
        <span className="text-lg font-semibold">Console</span>
        <Chip color={statusColor[status]} variant="flat" size="sm">
          {statusLabel[status]}
        </Chip>
        {loadError && (
          <Chip size="sm" variant="flat" color="danger">
            {loadError}
          </Chip>
        )}
        <Button
          size="sm"
          variant="light"
          className="ml-auto"
          startContent={<Trash2 size={14} />}
          onPress={clear}
          isDisabled={lines.length === 0}
        >
          Clear
        </Button>
      </CardHeader>

      <CardBody>
        {/* One surface: scrollback and prompt share a background and a border,
            so it reads as a terminal rather than a log box with a form under it. */}
        <div className="flex h-[60dvh] sm:h-[460px] flex-col rounded-lg border border-white/10 bg-black/40 font-mono text-xs">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2 leading-relaxed">
            {lines.map((line) => {
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
                      {line.entry.output || <span className="text-white/30">no output</span>}
                    </div>
                  )}
                  {suggestion && (
                    <button
                      type="button"
                      className="pl-4 text-primary-300 hover:underline"
                      onClick={() => setCommand(`${suggestion} `)}
                    >
                      Did you mean {suggestion}?
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="relative border-t border-white/10">
            {completions.length > 0 && (
              <div className="absolute bottom-full inset-x-0 mb-px max-h-64 overflow-y-auto rounded-t-lg border-t border-x border-white/10 bg-neutral-900 shadow-2xl">
                {completions.map((completion, index) => (
                  <button
                    key={completion.value}
                    type="button"
                    // Mouse-down, not click: the input must not lose focus
                    // before the selection is applied.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      accept(completion.value);
                    }}
                    onMouseEnter={() => setListIndex(index)}
                    className={`flex w-full items-baseline gap-3 px-4 py-1.5 text-left ${
                      index === listIndex ? 'bg-white/10' : ''
                    }`}
                  >
                    <span className="shrink-0 text-white/90">{completion.label}</span>
                    {completion.hint && (
                      <span className="truncate text-[11px] text-white/40">{completion.hint}</span>
                    )}
                    {index === listIndex && <span className="ml-auto shrink-0 text-[11px] text-white/30">tab</span>}
                  </button>
                ))}
              </div>
            )}

            {/* The command's shape, with the argument being typed picked out. */}
            {entry && slot > 0 && (
              <div className="px-4 pt-2 text-[11px] text-white/30">
                {usageParts.map((part, index) => (
                  <span key={`${part}-${index}`} className={index === slot ? 'text-white/80' : undefined}>
                    {part}{' '}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 px-4 py-2.5">
              <span className={running ? 'text-primary-300' : 'text-white/20'}>&gt;</span>
              <input
                ref={inputRef}
                value={command}
                onChange={(event) => {
                  setCommand(event.target.value);
                  setListOpen(true);
                }}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  setFocused(true);
                  setListOpen(true);
                }}
                onBlur={() => {
                  setFocused(false);
                  setListOpen(false);
                }}
                placeholder={placeholder}
                disabled={!running}
                autoComplete="off"
                spellCheck="false"
                className="flex-1 bg-transparent text-white placeholder:text-white/25 outline-none disabled:cursor-not-allowed"
              />
              <Button
                size="sm"
                variant="light"
                isIconOnly
                aria-label="Run command"
                onPress={send}
                isLoading={sending}
                isDisabled={!running || !command.trim()}
              >
                <CornerDownLeft size={14} className={focused && command.trim() ? 'text-primary-300' : undefined} />
              </Button>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
