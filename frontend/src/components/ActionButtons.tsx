import { ChangeEvent, useState } from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@heroui/react';
import {
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { ServerRecord } from '../lib/serverTypes';

type Props = {
  server: ServerRecord;
  busy?: string;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onUpload: (id: string, file: File) => void;
  onEdit: () => void;
  onDeleteContainer: () => void;
};

export function ActionButtons({ server, busy, onAction, onUpload, onEdit, onDeleteContainer }: Props) {
  const disabled = !!busy || server.status === 'creating';
  const canStart = server.status !== 'running' && server.status !== 'creating';
  const canStop = server.status === 'running';
  const canRestart = server.status === 'running';
  const hasPack = Boolean(server.serverPackUrl || server.packId);
  const canPrepare = server.status === 'stopped' && hasPack;
  const [confirmState, setConfirmState] = useState<null | 'stop' | 'restart' | 'delete'>(null);

  const handleFile = (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (file) {
      onUpload(server.id, file);
      evt.target.value = '';
    }
  };

  return (
    <div className="flex flex-wrap gap-2 justify-end">
      <input type="file" accept=".zip" className="hidden" id={`file-${server.id}`} onChange={handleFile} />
      <Button
        size="sm"
        color="warning"
        variant="flat"
        startContent={<Wand2 size={16} />}
        onPress={() => onAction(server.id, 'prepare')}
        isDisabled={disabled || busy === 'prepare' || !canPrepare}
      >
        {busy === 'prepare' ? 'Preparing…' : 'Prepare'}
      </Button>
      {canStart && (
        <Button
          size="sm"
          color="success"
          variant="flat"
          startContent={<Play size={16} />}
          onPress={() => onAction(server.id, 'start')}
          isDisabled={disabled || busy === 'start' || !server.containerId}
        >
          {busy === 'start' ? 'Starting…' : 'Start'}
        </Button>
      )}
      {canStop && (
        <Button
          size="sm"
          variant="flat"
          startContent={<Square size={16} />}
          onPress={() => setConfirmState('stop')}
          isDisabled={disabled || busy === 'stop'}
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </Button>
      )}
      {canRestart && (
        <Button
          size="sm"
          color="secondary"
          variant="flat"
          startContent={<RefreshCw size={16} />}
          onPress={() => setConfirmState('restart')}
          isDisabled={disabled || busy === 'restart'}
        >
          {busy === 'restart' ? 'Restarting…' : 'Restart'}
        </Button>
      )}
      <Button size="sm" variant="bordered" startContent={<Pencil size={16} />} onPress={onEdit}>
        Edit
      </Button>
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button size="sm" variant="flat" startContent={<MoreHorizontal size={16} />} isDisabled={disabled}>
            More
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="p-3 space-y-2 text-sm min-w-[160px]">
            <Tooltip content="Upload server pack zip">
              <Button
                size="sm"
                variant="flat"
                startContent={<Upload size={16} />}
                onPress={() => document.getElementById(`file-${server.id}`)?.click()}
                isDisabled={disabled || busy === 'upload'}
                fullWidth
              >
                {busy === 'upload' ? 'Uploading…' : 'Upload pack'}
              </Button>
            </Tooltip>
            <Button
              size="sm"
              color="danger"
              variant="flat"
              startContent={<Trash2 size={16} />}
              onPress={() => setConfirmState('delete')}
              isDisabled={disabled || busy === 'delete'}
              fullWidth
            >
              Delete container
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Modal isOpen={confirmState !== null} onClose={() => setConfirmState(null)} placement="center" size="sm">
        <ModalContent>
          {(onModalClose) => {
            const actionLabel = confirmState === 'stop' ? 'Stop server' : confirmState === 'restart' ? 'Restart server' : 'Delete container';
            const actionColor = confirmState === 'delete' ? 'danger' : 'warning';
            const actionFn = () => {
              if (confirmState === 'stop') onAction(server.id, 'stop');
              if (confirmState === 'restart') onAction(server.id, 'restart');
              if (confirmState === 'delete') onDeleteContainer();
              setConfirmState(null);
              onModalClose();
            };

            return (
              <>
                <ModalHeader>{actionLabel}</ModalHeader>
                <ModalBody className="text-sm">
                  {confirmState === 'delete'
                    ? 'This will remove the Docker container for this server. World data stays on disk.'
                    : 'Are you sure you want to proceed?'}
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onModalClose}>
                    Cancel
                  </Button>
                  <Button color={actionColor} onPress={actionFn}>
                    Confirm
                  </Button>
                </ModalFooter>
              </>
            );
          }}
        </ModalContent>
      </Modal>
    </div>
  );
}
