import { useEffect, useState } from 'react';
import {
  Button,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Progress,
  Select,
  SelectItem,
  Switch,
  Textarea,
} from '@heroui/react';
import { FirewallState, FormState, GameMode, ServerRecord, emptyForm } from '../lib/serverTypes';

const ROUTER_DOMAIN = process.env.NEXT_PUBLIC_ROUTER_DOMAIN;

const JAVA_IMAGE_PRESETS: { key: string; label: string }[] = [
  { key: '', label: 'Auto' },
  { key: 'eclipse-temurin:21-jre', label: 'Java 21 (eclipse-temurin:21-jre)' },
  { key: 'eclipse-temurin:17-jre', label: 'Java 17 (eclipse-temurin:17-jre)' },
  { key: 'eclipse-temurin:8-jre', label: 'Java 8 (eclipse-temurin:8-jre)' },
  { key: '__custom__', label: 'Custom…' },
];

function isKnownPreset(value: string) {
  return JAVA_IMAGE_PRESETS.some((preset) => preset.key === value);
}

function defaultJavaSelection(javaImage: string) {
  const trimmed = javaImage.trim();
  if (!trimmed) return '';
  if (isKnownPreset(trimmed)) return trimmed;
  return '__custom__';
}

type CreateProps = {
  open: boolean;
  onClose: () => void;
  form: FormState;
  setForm: (f: FormState) => void;
  packFile: File | null;
  setPackFile: (file: File | null) => void;
  onCreate: () => void;
  isCreating?: boolean;
  uploadProgress?: number | null;
};

export function CreateModal({
  open,
  onClose,
  form,
  setForm,
  packFile,
  setPackFile,
  onCreate,
  isCreating = false,
  uploadProgress,
}: CreateProps) {
  const progressValue = Math.min(100, Math.max(0, uploadProgress ?? 0));
  const [javaSelection, setJavaSelection] = useState<string>(defaultJavaSelection(form.javaImage));

  useEffect(() => {
    if (!open) return;
    setJavaSelection(defaultJavaSelection(form.javaImage));
  }, [open]);

  return (
    <Modal isOpen={open} onClose={onClose} placement="center" size="4xl" scrollBehavior="inside">
      <ModalContent className="max-w-5xl">
        {(onModalClose) => (
          <>
            <ModalHeader>Create server</ModalHeader>
            <ModalBody className="space-y-4">
              <Input
                label="Name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                isDisabled={isCreating}
              />
              <div>
                <Input
                  label="Subdomain"
                  placeholder="server1"
                  value={form.subdomain}
                  onChange={(e) => setForm({ ...form, subdomain: e.target.value })}
                  isDisabled={isCreating}
                />
                <div className="text-xs muted mt-1">
                  {ROUTER_DOMAIN
                    ? form.subdomain
                      ? `Full hostname: ${form.subdomain}.${ROUTER_DOMAIN}`
                      : `Full hostname: <subdomain>.${ROUTER_DOMAIN}`
                    : 'Optional. Used for wildcard subdomain routing if enabled.'}
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">Server pack zip</div>
                <input
                  type="file"
                  accept=".zip"
                  onChange={(e) => setPackFile(e.target.files?.[0] ?? null)}
                  className="text-sm"
                  disabled={isCreating}
                />
                <div className="text-xs muted">
                  {packFile ? `Selected: ${packFile.name}` : 'Required. Use the server pack zip you downloaded.'}
                </div>
                {isCreating && (
                  <Progress size="sm" value={progressValue} showValueLabel className="mt-2" />
                )}
              </div>
              <div>
                <Input
                  type="number"
                  label="Server port"
                  placeholder="Leave blank for auto-assign"
                  value={form.serverPort}
                  onChange={(e) => setForm({ ...form, serverPort: e.target.value })}
                  isDisabled={isCreating}
                />
                <div className="text-xs muted mt-1">Auto-assign uses the configured port range on the backend.</div>
              </div>
              <div>
                <Select
                  label="Java image"
                  selectedKeys={[javaSelection]}
                  onSelectionChange={(keys) => {
                    const key = String(Array.from(keys)[0] ?? '');
                    setJavaSelection(key);
                    if (key === '__custom__') return;
                    setForm({ ...form, javaImage: key });
                  }}
                  isDisabled={isCreating}
                >
                  {JAVA_IMAGE_PRESETS.map((preset) => (
                    <SelectItem key={preset.key}>{preset.label}</SelectItem>
                  ))}
                </Select>
                {javaSelection === '__custom__' && (
                  <Input
                    className="mt-2"
                    label="Custom Java image"
                    placeholder="eclipse-temurin:<major>-jre"
                    value={form.javaImage}
                    onChange={(e) => setForm({ ...form, javaImage: e.target.value })}
                    isDisabled={isCreating}
                  />
                )}
              </div>
              <Divider />
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Min RAM (MB)"
                  value={String(form.minRamMb)}
                  onChange={(e) => setForm({ ...form, minRamMb: Number(e.target.value) })}
                  isDisabled={isCreating}
                />
                <Input
                  type="number"
                  label="Max RAM (MB)"
                  value={String(form.maxRamMb)}
                  onChange={(e) => setForm({ ...form, maxRamMb: Number(e.target.value) })}
                  isDisabled={isCreating}
                />
                <Input
                  type="number"
                  label="CPU cap (cores)"
                  placeholder="Optional"
                  value={form.cpuLimit}
                  onChange={(e) => setForm({ ...form, cpuLimit: e.target.value })}
                  isDisabled={isCreating}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Render distance"
                  value={String(form.renderDistance)}
                  onChange={(e) => setForm({ ...form, renderDistance: Number(e.target.value) })}
                  isDisabled={isCreating}
                />
                <Select
                  label="Game mode"
                  selectedKeys={[form.gameMode]}
                  onSelectionChange={(keys) => setForm({ ...form, gameMode: Array.from(keys)[0] as GameMode })}
                  isDisabled={isCreating}
                >
                  <SelectItem key="survival">Survival</SelectItem>
                  <SelectItem key="creative">Creative</SelectItem>
                  <SelectItem key="adventure">Adventure</SelectItem>
                  <SelectItem key="spectator">Spectator</SelectItem>
                </Select>
                <Input
                  label="World seed"
                  value={form.seed}
                  onChange={(e) => setForm({ ...form, seed: e.target.value })}
                  isDisabled={isCreating}
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onModalClose} isDisabled={isCreating}>
                Cancel
              </Button>
              <Button color="primary" onPress={onCreate} isDisabled={isCreating}>
                {isCreating ? 'Uploading…' : 'Create'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

type EditProps = {
  server: ServerRecord | null;
  onClose: () => void;
  onSave: (id: string, changes: Partial<FormState>) => void;
};

export function EditModal({ server, onClose, onSave }: EditProps) {
  const [local, setLocal] = useState<FormState | null>(null);
  const [javaSelection, setJavaSelection] = useState<string>('');

  useEffect(() => {
    if (server) {
      setLocal({
        name: server.name,
        subdomain: server.subdomain ?? '',
        javaImage: server.javaImage ?? '',
        serverPort: String(server.serverPort),
        minRamMb: server.resources.minRamMb ?? emptyForm.minRamMb,
        maxRamMb: server.resources.maxRamMb ?? emptyForm.maxRamMb,
        cpuLimit: server.resources.cpuLimit?.toString() ?? '',
        renderDistance: server.game.renderDistance ?? emptyForm.renderDistance,
        gameMode: server.game.gameMode ?? emptyForm.gameMode,
        seed: server.game.seed ?? '',
      });
      setJavaSelection(defaultJavaSelection(server.javaImage ?? ''));
    } else {
      setLocal(null);
    }
  }, [server]);

  if (!server || !local) return null;

  return (
    <Modal isOpen onClose={onClose} placement="center" size="3xl" scrollBehavior="inside">
        <ModalContent className="max-w-4xl">
          {(onModalClose) => (
            <>
              <ModalHeader>Edit {server.name}</ModalHeader>
              <ModalBody className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Input
                      label="Subdomain"
                      value={local.subdomain}
                      onChange={(e) => setLocal({ ...local, subdomain: e.target.value })}
                    />
                    <div className="text-xs muted mt-1">
                      {ROUTER_DOMAIN
                        ? `Full hostname: ${local.subdomain || '<subdomain>'}.${ROUTER_DOMAIN}`
                        : 'Optional. Used for wildcard subdomain routing if enabled.'}
                    </div>
                  </div>
                  <div>
                    <Input
                      type="number"
                      label="Server port"
                      value={local.serverPort}
                      onChange={(e) => setLocal({ ...local, serverPort: e.target.value })}
                    />
                    <div className="text-xs muted mt-1">Changing the port recreates the container while stopped.</div>
                  </div>
                  <div>
                    <Select
                      label="Java image"
                      selectedKeys={[javaSelection]}
                      onSelectionChange={(keys) => {
                        const key = String(Array.from(keys)[0] ?? '');
                        setJavaSelection(key);
                        if (key === '__custom__') return;
                        setLocal({ ...local, javaImage: key });
                      }}
                    >
                      {JAVA_IMAGE_PRESETS.map((preset) => (
                        <SelectItem key={preset.key}>{preset.label}</SelectItem>
                      ))}
                    </Select>
                    {javaSelection === '__custom__' && (
                      <Input
                        className="mt-2"
                        label="Custom Java image"
                        placeholder="eclipse-temurin:<major>-jre"
                        value={local.javaImage}
                        onChange={(e) => setLocal({ ...local, javaImage: e.target.value })}
                      />
                    )}
                  </div>
                </div>
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

type FirewallProps = {
  server: ServerRecord | null;
  onClose: () => void;
  onSave: (id: string, changes: FirewallState) => void;
};

export function FirewallModal({ server, onClose, onSave }: FirewallProps) {
  const [local, setLocal] = useState<FirewallState | null>(null);

  useEffect(() => {
    if (server) {
      const whitelist = server.whitelist ?? [];
      const blacklist = server.blacklist ?? [];
      setLocal({
        whitelistEnabled: server.whitelistEnabled ?? whitelist.length > 0,
        whitelist: whitelist.join('\n'),
        blacklistEnabled: server.blacklistEnabled ?? blacklist.length > 0,
        blacklist: blacklist.join('\n'),
      });
    } else {
      setLocal(null);
    }
  }, [server]);

  if (!server || !local) return null;

  return (
    <Modal isOpen onClose={onClose} placement="center" size="4xl" scrollBehavior="inside">
      <ModalContent className="max-w-5xl">
        {(onModalClose) => (
          <>
            <ModalHeader>Firewall settings</ModalHeader>
            <ModalBody className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Switch isSelected={local.whitelistEnabled} onValueChange={(value) => setLocal({ ...local, whitelistEnabled: value })}>
                  Enable whitelist
                </Switch>
                <Switch isSelected={local.blacklistEnabled} onValueChange={(value) => setLocal({ ...local, blacklistEnabled: value })}>
                  Enable player blacklist
                </Switch>
              </div>

              <Divider />

              <div className="grid gap-3 md:grid-cols-2">
                <Textarea
                  label="Whitelist"
                  placeholder="One name or UUID per line"
                  minRows={6}
                  value={local.whitelist}
                  onChange={(e) => setLocal({ ...local, whitelist: e.target.value })}
                  isDisabled={!local.whitelistEnabled}
                />
                <Textarea
                  label="Player blacklist"
                  placeholder="One name or UUID per line"
                  minRows={6}
                  value={local.blacklist}
                  onChange={(e) => setLocal({ ...local, blacklist: e.target.value })}
                  isDisabled={!local.blacklistEnabled}
                />
              </div>
              <div className="text-xs muted">
                Online-mode: names are resolved to UUIDs when possible. If a name doesn&apos;t apply, paste the UUID instead.
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
