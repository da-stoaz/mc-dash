'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Cpu, Gamepad2, Loader2, Package, Settings2, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { Alert, Button, Divider, Input, Progress, Select, SelectItem, Switch, Textarea } from '@heroui/react';
import { API_BASE, apiFetch, apiOperation } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/apiErrors';
import { uploadInChunks } from '@/lib/chunkedUpload';
import { formatHostname, useRouterDomain } from '@/lib/routerDomain';
import { DIFFICULTIES, difficultyLabel, hasLiveProcess, type DifficultyOptions, type ServerRecord } from '@/lib/serverTypes';

type Props = {
  server: ServerRecord;
  busy: boolean;
  onUpdated: () => Promise<void>;
  onPrepare: () => Promise<void>;
  onDelete: () => void;
};

const sections = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'resources', label: 'Resources', icon: Cpu },
  { id: 'gameplay', label: 'Gameplay', icon: Gamepad2 },
  { id: 'players', label: 'Player access', icon: ShieldCheck },
  { id: 'pack', label: 'Server pack', icon: Package },
];

const inputClasses = {
  inputWrapper: 'has-[:user-invalid]:border-danger border-white/15 bg-transparent shadow-none data-[hover=true]:border-white/30',
  input: 'text-sm',
};

function Heading({ title, children }: { title: string; children: ReactNode }) {
  const Icon = sections.find(section => section.label === title)?.icon;
  return <div className="mb-5">
    <h3 className="flex items-center gap-2 text-base font-semibold">{Icon && <Icon size={17} className="muted" aria-hidden="true" />}{title}</h3>
    <p className="mt-1 text-xs leading-relaxed muted">{children}</p>
  </div>;
}

function Field({ label, description, children }: { label: string; description?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className="space-y-2">
    <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">{label}</label>
    {children(id)}
    {description && <p id={`${id}-description`} className="text-xs leading-relaxed muted">{description}</p>}
  </div>;
}

function Choice({ id, value, onChange, options, disabled }: {
  id: string; value: string; onChange: (value: string) => void;
  options: { value: string; label: string }[]; disabled?: boolean;
}) {
  return <Select id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`}
    variant="bordered" radius="sm" selectedKeys={[value]} isDisabled={disabled} aria-disabled={disabled || undefined} disableAnimation
    popoverProps={{ disableAnimation: true, shouldCloseOnScroll: false }} classNames={{ trigger: inputClasses.inputWrapper, value: 'text-sm' }}
    onSelectionChange={keys => {
      const selected = Array.from(keys)[0];
      if (selected !== undefined) onChange(String(selected));
    }}>
    {options.map(option => <SelectItem key={option.value}>{option.label}</SelectItem>)}
  </Select>;
}

// Each journey saves only its own changes. SSE updates refresh pristine forms,
// while unsaved edits survive live updates and navigation between sections.
function SettingsForm<T extends object>({ server, initial, toPatch, onUpdated, busy, children }: {
  server: ServerRecord; initial: T; toPatch: (values: T, baseline: T) => object;
  onUpdated: () => Promise<void>; busy: boolean;
  children: (values: T, set: <K extends keyof T>(key: K, value: T[K]) => void) => ReactNode;
}) {
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState({ values: initial, baseline: initial });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ error?: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(draft.values) !== JSON.stringify(draft.baseline);
  const savingRef = useRef(false);

  useEffect(() => {
    setDraft(previous => JSON.stringify(previous.values) === JSON.stringify(previous.baseline) && !savingRef.current
      ? { values: JSON.parse(initialKey) as T, baseline: JSON.parse(initialKey) as T }
      : previous);
  }, [initialKey, saving]);

  return <form onInvalidCapture={() => setNotice({ error: true, text: 'Check the field values before saving.' })} onSubmit={async event => {
    event.preventDefault();
    if (!dirty || savingRef.current || busy) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiOperation(`${API_BASE}/servers/${server.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPatch(draft.values, draft.baseline)),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, 'Could not save changes'));
      const updated = await response.json() as ServerRecord;
      setDraft(previous => ({ values: previous.values, baseline: previous.values }));
      setNotice({ text: updated.restartRequired
        ? 'Saved. Restart the server to apply these changes.'
        : hasLiveProcess(updated.status) ? 'Saved. Changes applied to the running server.' : 'Saved. Changes will apply the next time the server starts.' });
      await onUpdated();
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : 'Could not save changes. Try again.' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }}>
    <fieldset disabled={saving || busy} className="space-y-5 disabled:opacity-60">
      {children(draft.values, (key, value) => {
        setDraft(previous => ({ ...previous, values: { ...previous.values, [key]: value } }));
        setNotice(null);
      })}
    </fieldset>
    {notice && <Alert color={notice.error ? 'danger' : 'success'} variant="flat"
      role={notice.error ? 'alert' : 'status'} className="mt-6" description={notice.text} />}
    {(dirty || saving || notice) && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
      <p className="text-xs muted" role="status">{dirty ? 'You have unsaved changes' : 'All changes saved'}</p>
      <div className="flex gap-2">
        <Button size="sm" type="button" variant="light" isDisabled={!dirty || saving || busy} onPress={() => {
          setDraft({ values: initial, baseline: initial }); setNotice(null);
        }}>Discard</Button>
        <Button size="sm" color="primary" type="submit" isDisabled={!dirty || saving || busy}>{saving && <Loader2 className="animate-spin" />} {saving ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </div>}
  </form>;
}

function GeneralSettings({ server, busy, onUpdated }: Props) {
  const routerDomain = useRouterDomain();
  const portLocked = hasLiveProcess(server.status) || server.status === 'stopping' || server.status === 'creating';
  return <>
    <Heading title="General">Give your server a name and choose how players connect.</Heading>
    <SettingsForm server={server} busy={busy} onUpdated={onUpdated}
      initial={{ name: server.name, subdomain: server.subdomain ?? '', port: String(server.serverPort) }}
      toPatch={(values, baseline) => ({
        ...(values.name !== baseline.name && { name: values.name.trim() }),
        ...(values.subdomain !== baseline.subdomain && { subdomain: values.subdomain.trim() }),
        ...(values.port !== baseline.port && { serverPort: Number(values.port) }),
      })}>
      {(values, set) => <>
        <Field label="Server name" description="A display name for your dashboard. Renaming does not restart the server.">
          {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} required maxLength={120} pattern=".*\S.*" value={values.name} onChange={event => set('name', event.target.value)} />}
        </Field>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Subdomain" description={routerDomain ? formatHostname(values.subdomain, routerDomain) : 'Used when hostname routing is enabled.'}>
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} value={values.subdomain} pattern="[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*" onChange={event => set('subdomain', event.target.value)} placeholder="my-server" />}
          </Field>
          <Field label="Server port" description={portLocked ? 'Stop the server before changing its port.' : 'Players connect to this port. The container is recreated if it changes.'}>
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} required type="number" min={1024} max={65535} isDisabled={portLocked} value={values.port} onChange={event => set('port', event.target.value)} />}
          </Field>
        </div>
      </>}
    </SettingsForm>
    <details className="group mt-5 border-t border-white/10 pt-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">Technical details <ChevronDown size={15} className="transition-transform group-open:rotate-180" /></summary>
      <dl className="mt-4 space-y-3 text-xs">
        <div><dt className="muted">Server ID</dt><dd className="mt-1 break-all font-mono">{server.id}</dd></div>
        <div><dt className="muted">Container</dt><dd className="mt-1 break-all font-mono">{server.containerId ?? 'Created when the server is prepared'}</dd></div>
      </dl>
    </details>
  </>;
}

function GameplaySettings({ server, busy, onUpdated }: Props) {
  const [checked, setChecked] = useState<{ options: DifficultyOptions; configured: ServerRecord['game']['difficulty'] } | null>(null);
  const [difficultyError, setDifficultyError] = useState(false);
  const options = checked?.configured === server.game.difficulty ? checked?.options ?? null : null;
  useEffect(() => {
    let active = true;
    apiFetch(`${API_BASE}/servers/${server.id}/difficulty`).then(async response => {
      if (!response.ok) throw new Error('Difficulty unavailable');
      const result = await response.json() as DifficultyOptions;
      if (active) { setChecked({ options: result, configured: server.game.difficulty }); setDifficultyError(false); }
    }).catch(() => { if (active) setDifficultyError(true); });
    return () => { active = false; };
  }, [server.id, server.game.difficulty]);
  const seedLocked = Boolean(server.containerId);
  return <>
    <Heading title="Gameplay">Shape the experience for your players.</Heading>
    <SettingsForm server={server} busy={busy} onUpdated={onUpdated}
      initial={{ gameMode: server.game.gameMode ?? 'survival', difficulty: options?.current ?? server.game.difficulty ?? 'normal', renderDistance: String(server.game.renderDistance ?? 10), entityRange: String(server.game.entityBroadcastRangePercentage ?? 100), seed: server.game.seed ?? '' }}
      toPatch={(values, baseline) => ({ game: {
        // The API replaces the game object, so preserve its untouched fields.
        ...server.game,
        ...(options?.current && { difficulty: options.current }),
        ...(values.gameMode !== baseline.gameMode && { gameMode: values.gameMode }),
        ...(values.difficulty !== baseline.difficulty && { difficulty: values.difficulty }),
        ...(values.renderDistance !== baseline.renderDistance && { renderDistance: Number(values.renderDistance) }),
        ...(values.entityRange !== baseline.entityRange && { entityBroadcastRangePercentage: Number(values.entityRange) }),
        ...(values.seed !== baseline.seed && !seedLocked && { seed: values.seed }),
      } })}>
      {(values, set) => <>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Game mode" description="The default mode for players joining the world.">
            {id => <Choice id={id} value={values.gameMode} onChange={value => set('gameMode', value as typeof values.gameMode)} options={['survival', 'creative', 'adventure', 'spectator'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} />}
          </Field>
          <Field label="Difficulty" description={options?.locked ? options.lockedReason ?? 'Hardcore worlds are locked to Hard.' : difficultyError ? 'Could not check this world’s difficulty. Reload to try again.' : !options ? 'Checking world settings…' : 'Applied live when the server supports it.'}>
            {id => <Choice id={id} value={values.difficulty} onChange={value => set('difficulty', value as typeof values.difficulty)} disabled={!options || options.locked} options={(options?.available ?? DIFFICULTIES).map(value => ({ value, label: difficultyLabel[value] }))} />}
          </Field>
        </div>
        <Divider />
        <div><h4 className="text-sm font-medium">World & visibility</h4><p className="mt-1 text-xs muted">Visibility changes take effect after a restart.</p></div>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Render distance (chunks)" description="How far the world loads around each player. Lower values use fewer resources.">
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} type="number" min={2} max={32} required value={values.renderDistance} onChange={event => set('renderDistance', event.target.value)} />}
          </Field>
          <Field label="Entity broadcast range (%)" description="100% is the normal range; 50% halves how far away entities are sent to players.">
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} type="number" min={10} max={1000} required value={values.entityRange} onChange={event => set('entityRange', event.target.value)} />}
          </Field>
        </div>
        <Field label="World seed" description={seedLocked ? 'Locked after preparation. Changing a seed cannot change an existing world.' : 'Leave empty for a random world. Set before preparing the server.'}>
          {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} isDisabled={seedLocked} value={values.seed} onChange={event => set('seed', event.target.value)} placeholder="Random" />}
        </Field>
      </>}
    </SettingsForm>
  </>;
}

function ResourceSettings({ server, busy, onUpdated }: Props) {
  return <>
    <Heading title="Resources">Balance server performance with the capacity of your host.</Heading>
    <SettingsForm server={server} busy={busy} onUpdated={onUpdated}
      initial={{ minimum: String(server.resources.minRamMb), maximum: String(server.resources.maxRamMb), cpu: server.resources.cpuLimit?.toString() ?? '' }}
      toPatch={(values, baseline) => ({ resources: {
        ...server.resources,
        ...(values.minimum !== baseline.minimum && { minRamMb: Number(values.minimum) }),
        ...(values.maximum !== baseline.maximum && { maxRamMb: Number(values.maximum) }),
        ...(values.cpu !== baseline.cpu && { cpuLimit: values.cpu ? Number(values.cpu) : undefined }),
      } })}>
      {(values, set) => <>
        <div><h4 className="text-sm font-medium">Memory</h4><p className="mt-1 text-xs muted">Set the initial Java heap and total server memory limit. 1,024 MiB = 1 GiB.</p></div>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Initial Java heap (MiB)" description="The starting heap size. MC Dash can adjust it to fit the RAM limit.">
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} type="number" min={1} max={Number(values.maximum) || undefined} step={1} required value={values.minimum} onChange={event => set('minimum', event.target.value)} />}
          </Field>
          <Field label="RAM limit (MiB)" description="Total container memory, including Java overhead.">
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} type="number" min={Math.max(512, Number(values.minimum) || 0)} step={1} required value={values.maximum} onChange={event => set('maximum', event.target.value)} />}
          </Field>
        </div>
        <Divider />
        <Field label="CPU limit (cores)" description="Leave empty for no CPU cap. Fractions such as 1.5 are supported.">
          {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} className="sm:max-w-xs" type="number" min={0.01} step="any" placeholder="Unlimited" value={values.cpu} onChange={event => set('cpu', event.target.value)} />}
        </Field>
        <p className="rounded-md bg-white/5 px-4 py-3 text-xs leading-relaxed muted">MC Dash reserves room for Java overhead within the RAM limit. Unused memory is shared with other servers; host capacity is checked before starting a server or increasing its limit.</p>
      </>}
    </SettingsForm>
  </>;
}

function PlayerSettings({ server, busy, onUpdated }: Props) {
  return <>
    <Heading title="Player access">Choose who can join your server.</Heading>
    <SettingsForm server={server} busy={busy} onUpdated={onUpdated}
      initial={{ whitelistEnabled: server.whitelistEnabled ?? Boolean(server.whitelist?.length), whitelist: (server.whitelist ?? []).join('\n'), blacklistEnabled: server.blacklistEnabled ?? Boolean(server.blacklist?.length), blacklist: (server.blacklist ?? []).join('\n') }}
      toPatch={(values, baseline) => {
        const patch: Record<string, unknown> = {};
        for (const key of ['whitelistEnabled', 'blacklistEnabled'] as const) if (values[key] !== baseline[key]) patch[key] = values[key];
        for (const key of ['whitelist', 'blacklist'] as const) if (values[key] !== baseline[key]) patch[key] = values[key].split('\n').map(entry => entry.trim()).filter(Boolean);
        return patch;
      }}>
      {(values, set) => <>
        {(['whitelist', 'blacklist'] as const).map((list, index) => <div key={list}>
          {index > 0 && <Divider className="mb-6" />}
          <div className="mb-4 flex items-start justify-between gap-6">
            <div><label id={`${server.id}-${list}-label`} htmlFor={`${server.id}-${list}-enabled`} className="text-sm font-medium">{list === 'whitelist' ? 'Only allow invited players' : 'Block specific players'}</label><p className="mt-1 text-xs leading-relaxed muted">{list === 'whitelist' ? 'When enabled, only players on this list can join.' : 'When enabled, players on this list cannot join.'}</p></div>
            <Switch id={`${server.id}-${list}-enabled`} aria-labelledby={`${server.id}-${list}-label`} size="sm" isSelected={values[`${list}Enabled`]} onValueChange={value => set(`${list}Enabled`, value)} />
          </div>
          <Field label={list === 'whitelist' ? 'Allowed players' : 'Blocked players'} description="One Minecraft name or UUID per line. Lists are kept when disabled.">
            {id => <Textarea variant="bordered" radius="sm" minRows={4} id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} value={values[list]} onChange={event => set(list, event.target.value)} placeholder={'Steve\nAlex'} className="resize-y font-mono text-sm" />}
          </Field>
        </div>)}
        <p className="text-xs leading-relaxed muted">Names are resolved to UUIDs when possible. If a name does not apply, use its UUID. Player bans can apply live; whitelist changes may require a restart.</p>
      </>}
    </SettingsForm>
  </>;
}

function PackSettings({ server, busy, onUpdated, onPrepare }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stopped = ['stopped', 'exited', 'error'].includes(server.status);
  const pending = Boolean(server.serverPackUrl) && !server.packReady;
  const javaOptions = [
    { value: 'auto', label: 'Auto-detect from server pack' },
    ...[25, 21, 17, 11, 8].map(major => ({ value: `eclipse-temurin:${major}-jre`, label: `Java ${major} · Eclipse Temurin` })),
    { value: 'custom', label: 'Custom image…' },
  ];
  const initialRuntime = !server.javaImage ? 'auto'
    : javaOptions.some(option => option.value === server.javaImage) ? server.javaImage : 'custom';
  return <>
    <Heading title="Server pack">Update your modpack and choose its Java runtime.</Heading>
    <div className="grid items-start gap-6 lg:grid-cols-2">
    <div>
    <div className="mb-6 flex items-center gap-3 rounded-lg border border-white/10 p-4">
      <div className="rounded-md bg-white/5 p-2.5"><Package size={20} className="muted" /></div>
      <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{server.serverPackName ?? (server.packReady ? 'Imported from snapshot' : 'No server pack uploaded')}</p><p className="mt-1 text-xs muted">{pending ? 'Uploaded · preparation required' : server.packReady ? 'Current server pack' : 'Upload a server pack to get started'}</p></div>
      {server.packReady && <Check size={16} className="shrink-0 text-emerald-400" />}
    </div>
    <div className="space-y-4">
      <div><h4 className="text-sm font-medium">Replace server pack</h4><p className="mt-1 text-xs leading-relaxed muted">Upload a ZIP, then prepare the server to apply it. Your existing world is preserved. Create a snapshot first if you need a rollback.</p></div>
      {!stopped && <Alert color="warning" variant="flat" description="Stop the server to upload or prepare a replacement pack." />}
      <Field label="Server pack ZIP">
        {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} ref={fileRef} type="file" accept=".zip" isDisabled={!stopped || uploading || busy} className="h-auto py-2 file:mr-4 file:cursor-pointer file:text-foreground" onChange={event => {
          const selected = event.target.files?.[0] ?? null;
          if (selected && !selected.name.toLowerCase().endsWith('.zip')) { setError('Choose a ZIP server pack.'); setFile(null); return; }
          setFile(selected); setError(null);
        }} />}
      </Field>
      {uploading && <Progress aria-label="Pack upload progress" value={progress} showValueLabel size="sm" />}
      {error && <Alert color="danger" variant="flat" description={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" type="button" variant="flat" isDisabled={!file || !stopped || uploading || busy} onPress={async () => {
          if (!file || uploading) return;
          setUploading(true); setProgress(0); setError(null);
          try {
            const uploadId = await uploadInChunks(file, { onProgress: fraction => setProgress(Math.round(fraction * 100)) });
            const body = new FormData(); body.append('uploadId', uploadId);
            const response = await apiFetch(`${API_BASE}/servers/${server.id}/pack`, { method: 'POST', body });
            if (!response.ok) throw new Error(await getApiErrorMessage(response, 'Pack upload failed'));
            setFile(null); if (fileRef.current) fileRef.current.value = '';
            await onUpdated();
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Pack upload failed. Try again.'); }
          finally { setUploading(false); }
        }}>{uploading ? <Loader2 className="animate-spin" /> : <Upload />}{uploading ? 'Uploading…' : 'Upload pack'}</Button>
        {pending && <Button size="sm" type="button" color="primary" onPress={onPrepare} isDisabled={!stopped || busy || uploading}>Prepare server</Button>}
      </div>
      {pending && <p role="status" className="text-xs text-amber-300">Your pack is uploaded. Prepare the server before starting it.</p>}
    </div>
    </div>
    <div className="border-t border-white/10 pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
    <SettingsForm server={server} busy={busy || uploading || !stopped} onUpdated={onUpdated}
      initial={{ runtime: initialRuntime, custom: initialRuntime === 'custom' ? server.javaImage ?? '' : '' }}
      toPatch={values => ({ javaImage: values.runtime === 'auto' ? null : values.runtime === 'custom' ? values.custom.trim() : values.runtime })}>
      {(values, set) => {
        return <>
          <Field label="Java runtime" description={stopped ? 'Auto-detect selects a compatible runtime from the pack.' : 'Stop the server before changing its Java runtime.'}>
            {id => <Choice id={id} value={values.runtime} onChange={value => set('runtime', value)} options={javaOptions} />}
          </Field>
          {values.runtime === 'custom' && <Field label="Custom Java image" description="A Docker image with a compatible Java runtime.">
            {id => <Input validationBehavior="aria" variant="bordered" radius="sm" classNames={inputClasses} id={id} aria-labelledby={`${id}-label`} required pattern=".*\S.*" value={values.custom} onChange={event => set('custom', event.target.value)} placeholder="eclipse-temurin:21-jre" />}
          </Field>}
          <p className="text-xs leading-relaxed muted">Current runtime: <span className="font-mono text-foreground">{server.effectiveJavaImage ?? server.javaImage ?? 'Detected during preparation'}</span>{server.packRecommendedJavaMajor && <><br />Pack recommends Java {server.packRecommendedJavaMajor}.</>}</p>
        </>;
      }}
    </SettingsForm>
    </div>
    </div>
  </>;
}

export function SettingsPanel(props: Props) {
  return <section aria-label="Server settings" className="space-y-5">
    <div>
      <h2 className="text-base font-semibold">Server settings</h2>
      <p className="mt-1 text-sm muted">All your server settings in one place. Save changes in each section.</p>
      <nav aria-label="Jump to settings" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="muted">Jump to</span>
        {sections.map(({ id, label }) => <a key={id} href={`#settings-${id}`}
          className="rounded-sm text-cyan-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-cyan-400">
          {id === 'resources' ? 'RAM & CPU' : id === 'pack' ? 'Server pack & Java' : label}
        </a>)}
      </nav>
    </div>
    <div className="grid items-start gap-5 xl:grid-cols-2">
      {sections.map(({ id, label }) => <section key={id} id={`settings-${id}`} aria-label={label} tabIndex={-1}
        className={`min-w-0 scroll-mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-5 focus-visible:outline-2 focus-visible:outline-cyan-400 ${id === 'pack' ? 'xl:col-span-2' : ''}`}>
        {id === 'general' && <GeneralSettings {...props} />}
        {id === 'gameplay' && <GameplaySettings {...props} />}
        {id === 'resources' && <ResourceSettings {...props} />}
        {id === 'players' && <PlayerSettings {...props} />}
        {id === 'pack' && <PackSettings {...props} />}
      </section>)}
    </div>
    <section aria-label="Delete server" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-rose-500/20 bg-rose-500/5 p-5">
      <div><h3 className="text-sm font-medium text-rose-300">Delete server</h3><p className="mt-1 text-xs leading-relaxed muted">Permanently remove this server, its worlds, and snapshots. This cannot be undone.</p></div>
      <Button size="sm" type="button" variant="flat" color="danger" onPress={props.onDelete} isDisabled={props.busy} startContent={<Trash2 size={15} />}>Delete server</Button>
    </section>
  </section>;
}
