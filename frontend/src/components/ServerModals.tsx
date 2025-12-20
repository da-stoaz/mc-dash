import { useEffect, useState } from 'react';
import { Button, Divider, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem } from '@heroui/react';
import { FormState, GameMode, ServerRecord, emptyForm } from '../lib/serverTypes';

type CreateProps = {
  open: boolean;
  onClose: () => void;
  form: FormState;
  setForm: (f: FormState) => void;
  onCreate: () => void;
};

export function CreateModal({ open, onClose, form, setForm, onCreate }: CreateProps) {
  return (
    <Modal isOpen={open} onClose={onClose} placement="center" size="4xl" scrollBehavior="inside">
      <ModalContent className="max-w-5xl">
        {(onModalClose) => (
          <>
            <ModalHeader>Create server</ModalHeader>
            <ModalBody className="space-y-4">
              <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Divider />
              <div className="grid gap-3 md:grid-cols-2">
                <Input label="CurseForge Mod ID" value={form.packId} onChange={(e) => setForm({ ...form, packId: e.target.value })} />
                <Input label="File ID (server pack)" value={form.packFileId} onChange={(e) => setForm({ ...form, packFileId: e.target.value })} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Input label="Version label" value={form.packVersion} onChange={(e) => setForm({ ...form, packVersion: e.target.value })} />
                <Input
                  label="Server pack URL or local path"
                  placeholder="https://... or /path/to/pack.zip"
                  value={form.serverPackUrl}
                  onChange={(e) => setForm({ ...form, serverPackUrl: e.target.value })}
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
        packId: String(server.packId ?? ''),
        packFileId: String(server.packFileId ?? ''),
        packVersion: server.packVersion ?? '',
        serverPackUrl: server.serverPackUrl ?? '',
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
