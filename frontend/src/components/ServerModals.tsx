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
  Select,
  SelectItem,
  Switch,
  Textarea,
} from '@heroui/react';
import { FirewallState, FormState, GameMode, ServerRecord, emptyForm } from '../lib/serverTypes';

type CreateProps = {
  open: boolean;
  onClose: () => void;
  form: FormState;
  setForm: (f: FormState) => void;
  packFile: File | null;
  setPackFile: (file: File | null) => void;
  onCreate: () => void;
};

export function CreateModal({ open, onClose, form, setForm, packFile, setPackFile, onCreate }: CreateProps) {
  return (
    <Modal isOpen={open} onClose={onClose} placement="center" size="4xl" scrollBehavior="inside">
      <ModalContent className="max-w-5xl">
        {(onModalClose) => (
          <>
            <ModalHeader>Create server</ModalHeader>
            <ModalBody className="space-y-4">
              <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <div className="space-y-2">
                <div className="text-sm font-medium">Server pack zip</div>
                <input
                  type="file"
                  accept=".zip"
                  onChange={(e) => setPackFile(e.target.files?.[0] ?? null)}
                  className="text-sm"
                />
                <div className="text-xs muted">
                  {packFile ? `Selected: ${packFile.name}` : 'Required. Use the server pack zip you downloaded.'}
                </div>
              </div>
              <div>
                <Input
                  label="Java image override"
                  placeholder="eclipse-temurin:21-jre (leave blank for auto)"
                  value={form.javaImage}
                  onChange={(e) => setForm({ ...form, javaImage: e.target.value })}
                />
              </div>
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

type EditProps = {
  server: ServerRecord | null;
  onClose: () => void;
  onSave: (id: string, changes: Partial<FormState>) => void;
};

export function EditModal({ server, onClose, onSave }: EditProps) {
  const [local, setLocal] = useState<FormState | null>(null);

  useEffect(() => {
    if (server) {
      setLocal({
        name: server.name,
        javaImage: server.javaImage ?? '',
        minRamMb: server.resources.minRamMb ?? emptyForm.minRamMb,
        maxRamMb: server.resources.maxRamMb ?? emptyForm.maxRamMb,
        cpuLimit: server.resources.cpuLimit?.toString() ?? '',
        renderDistance: server.game.renderDistance ?? emptyForm.renderDistance,
        gameMode: server.game.gameMode ?? emptyForm.gameMode,
        seed: server.game.seed ?? '',
      });
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
              <Input
                label="Java image override"
                placeholder="eclipse-temurin:21-jre (leave blank for auto)"
                value={local.javaImage}
                onChange={(e) => setLocal({ ...local, javaImage: e.target.value })}
              />
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
      const ipBlacklist = server.ipBlacklist ?? [];
      setLocal({
        whitelistEnabled: server.whitelistEnabled ?? whitelist.length > 0,
        whitelist: whitelist.join('\n'),
        blacklistEnabled: server.blacklistEnabled ?? blacklist.length > 0,
        blacklist: blacklist.join('\n'),
        ipBlacklistEnabled: server.ipBlacklistEnabled ?? ipBlacklist.length > 0,
        ipBlacklist: ipBlacklist.join('\n'),
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
              <div className="grid gap-3 md:grid-cols-3">
                <Switch isSelected={local.whitelistEnabled} onValueChange={(value) => setLocal({ ...local, whitelistEnabled: value })}>
                  Enable whitelist
                </Switch>
                <Switch isSelected={local.blacklistEnabled} onValueChange={(value) => setLocal({ ...local, blacklistEnabled: value })}>
                  Enable player blacklist
                </Switch>
                <Switch isSelected={local.ipBlacklistEnabled} onValueChange={(value) => setLocal({ ...local, ipBlacklistEnabled: value })}>
                  Enable IP blacklist
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
              <Textarea
                label="IP blacklist"
                placeholder="One IP per line"
                minRows={4}
                value={local.ipBlacklist}
                onChange={(e) => setLocal({ ...local, ipBlacklist: e.target.value })}
                isDisabled={!local.ipBlacklistEnabled}
              />
              <div className="text-xs muted">Use UUIDs for online-mode servers. Names use offline UUIDs.</div>
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
