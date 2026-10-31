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
} from '@heroui/react';
import {
  DIFFICULTIES,
  Difficulty,
  FormState,
  GameMode,
  difficultyLabel,
  emptyForm,
} from '../lib/serverTypes';
import { FilePicker } from './FilePicker';
import { useRouterDomain } from '../lib/routerDomain';

// The LTS majors Temurin publishes -jre images for. Keep in step with
// PUBLISHED_JAVA_MAJORS in backend/src/services/prepareService.ts, which snaps
// auto-detected versions onto this same set. These are shortcuts only — "Auto"
// and "Custom…" are not limited to what is listed here.
const JAVA_IMAGE_PRESETS: { key: string; label: string }[] = [
  { key: '', label: 'Auto' },
  { key: 'eclipse-temurin:25-jre', label: 'Java 25 (eclipse-temurin:25-jre)' },
  { key: 'eclipse-temurin:21-jre', label: 'Java 21 (eclipse-temurin:21-jre)' },
  { key: 'eclipse-temurin:17-jre', label: 'Java 17 (eclipse-temurin:17-jre)' },
  { key: 'eclipse-temurin:11-jre', label: 'Java 11 (eclipse-temurin:11-jre)' },
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
  const routerDomain = useRouterDomain();
  const [javaSelection, setJavaSelection] = useState<string>(defaultJavaSelection(form.javaImage));

  useEffect(() => {
    if (!open) return;
    setJavaSelection(defaultJavaSelection(form.javaImage));
  }, [open]);

  return (
    <Modal isOpen={open} onClose={onClose} placement="auto" size="4xl" scrollBehavior="inside">
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
                  {routerDomain
                    ? `Full hostname: ${form.subdomain || '<subdomain>'}.${routerDomain}`
                    : 'Optional. Used for wildcard subdomain routing if enabled.'}
                </div>
              </div>
              <div>
                <FilePicker
                  label="Server pack zip"
                  accept=".zip"
                  file={packFile}
                  onFileChange={setPackFile}
                  isDisabled={isCreating}
                  description="Required. Use the server pack zip you downloaded from CurseForge."
                />
                {isCreating && (
                  <Progress aria-label="Upload progress" size="sm" value={progressValue} showValueLabel className="mt-2" />
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
                  label="Initial Java heap (MiB)"
                  value={String(form.minRamMb)}
                  onChange={(e) => setForm({ ...form, minRamMb: Number(e.target.value) })}
                  isDisabled={isCreating}
                />
                <Input
                  type="number"
                  label="RAM limit (MiB)"
                  description="Total container memory, including Java overhead."
                  min={512}
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
                <Input
                  type="number"
                  label="Entity broadcast range (%)"
                  description="100% is the normal range; 50% halves it. Takes effect on restart."
                  min={10}
                  max={1000}
                  step={1}
                  value={String(form.entityBroadcastRangePercentage)}
                  onChange={(e) => setForm({ ...form, entityBroadcastRangePercentage: Number(e.target.value) })}
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
                <Select
                  label="Difficulty"
                  selectedKeys={[form.difficulty]}
                  onSelectionChange={(keys) => setForm({ ...form, difficulty: Array.from(keys)[0] as Difficulty })}
                  isDisabled={isCreating}
                >
                  {DIFFICULTIES.map((value) => (
                    <SelectItem key={value}>{difficultyLabel[value]}</SelectItem>
                  ))}
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

export type ImportFields = {
  name: string;
  subdomain: string;
  serverPort: string;
  javaImage: string;
  minRamMb: number;
  maxRamMb: number;
  cpuLimit: string;
};

const emptyImport: ImportFields = {
  name: '',
  subdomain: '',
  serverPort: '',
  javaImage: '',
  minRamMb: emptyForm.minRamMb,
  maxRamMb: emptyForm.maxRamMb,
  cpuLimit: '',
};

type ImportProps = {
  open: boolean;
  onClose: () => void;
  onImport: (fields: ImportFields, archive: File) => void;
  isImporting?: boolean;
  uploadProgress?: number | null;
};

export function ImportModal({ open, onClose, onImport, isImporting = false, uploadProgress }: ImportProps) {
  const progressValue = Math.min(100, Math.max(0, uploadProgress ?? 0));
  const routerDomain = useRouterDomain();
  const [fields, setFields] = useState<ImportFields>({ ...emptyImport });
  const [archive, setArchive] = useState<File | null>(null);
  const [javaSelection, setJavaSelection] = useState<string>('');

  // Reset the form each time the modal is opened fresh.
  useEffect(() => {
    if (!open) return;
    setFields({ ...emptyImport });
    setArchive(null);
    setJavaSelection('');
  }, [open]);

  const canSubmit = fields.name.trim().length > 0 && archive !== null && !isImporting;

  return (
    <Modal isOpen={open} onClose={onClose} placement="auto" size="3xl" scrollBehavior="inside">
      <ModalContent className="max-w-4xl">
        {(onModalClose) => (
          <>
            <ModalHeader>Import server from snapshot</ModalHeader>
            <ModalBody className="space-y-4">
              <div className="text-xs muted">
                Upload a snapshot archive (the <code>.tar.gz</code> downloaded from any server&apos;s snapshots). The world and
                game settings come from the archive; the fields below configure this new instance.
              </div>
              <Input
                label="Name"
                required
                value={fields.name}
                onChange={(e) => setFields({ ...fields, name: e.target.value })}
                isDisabled={isImporting}
              />
              <div>
                <FilePicker
                  label="Snapshot archive"
                  accept=".gz,.tgz,.tar.gz,application/gzip"
                  file={archive}
                  onFileChange={setArchive}
                  isDisabled={isImporting}
                  description="Required. A snapshot .tar.gz exported from MC Dash."
                />
                {isImporting && (
                  <Progress aria-label="Upload progress" size="sm" value={progressValue} showValueLabel className="mt-2" />
                )}
              </div>
              <div>
                <Input
                  label="Subdomain"
                  placeholder="server1"
                  value={fields.subdomain}
                  onChange={(e) => setFields({ ...fields, subdomain: e.target.value })}
                  isDisabled={isImporting}
                />
                <div className="text-xs muted mt-1">
                  {routerDomain
                    ? `Full hostname: ${fields.subdomain || '<subdomain>'}.${routerDomain}`
                    : 'Optional. Auto-assigned from the name if left blank.'}
                </div>
              </div>
              <div>
                <Input
                  type="number"
                  label="Server port"
                  placeholder="Leave blank for auto-assign"
                  value={fields.serverPort}
                  onChange={(e) => setFields({ ...fields, serverPort: e.target.value })}
                  isDisabled={isImporting}
                />
                <div className="text-xs muted mt-1">A fresh port is assigned so the import can run alongside its source.</div>
              </div>
              <div>
                <Select
                  label="Java image"
                  selectedKeys={[javaSelection]}
                  onSelectionChange={(keys) => {
                    const key = String(Array.from(keys)[0] ?? '');
                    setJavaSelection(key);
                    if (key === '__custom__') return;
                    setFields({ ...fields, javaImage: key });
                  }}
                  isDisabled={isImporting}
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
                    value={fields.javaImage}
                    onChange={(e) => setFields({ ...fields, javaImage: e.target.value })}
                    isDisabled={isImporting}
                  />
                )}
              </div>
              <Divider />
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  type="number"
                  label="Initial Java heap (MiB)"
                  value={String(fields.minRamMb)}
                  onChange={(e) => setFields({ ...fields, minRamMb: Number(e.target.value) })}
                  isDisabled={isImporting}
                />
                <Input
                  type="number"
                  label="RAM limit (MiB)"
                  description="Total container memory, including Java overhead."
                  min={512}
                  value={String(fields.maxRamMb)}
                  onChange={(e) => setFields({ ...fields, maxRamMb: Number(e.target.value) })}
                  isDisabled={isImporting}
                />
                <Input
                  type="number"
                  label="CPU cap (cores)"
                  placeholder="Optional"
                  value={fields.cpuLimit}
                  onChange={(e) => setFields({ ...fields, cpuLimit: e.target.value })}
                  isDisabled={isImporting}
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onModalClose} isDisabled={isImporting}>
                Cancel
              </Button>
              <Button color="primary" onPress={() => archive && onImport(fields, archive)} isDisabled={!canSubmit}>
                {isImporting ? 'Importing…' : 'Import'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
