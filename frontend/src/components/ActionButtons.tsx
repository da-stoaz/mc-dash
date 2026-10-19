import { useState } from 'react';
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
} from '@heroui/react';
import {
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import { ServerRecord } from '../lib/serverTypes';

type Props = {
  server: ServerRecord;
  busy?: string;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onEdit: () => void;
  onDeleteServer: () => void;
  align?: 'start' | 'end';
};

export function ActionButtons({ server, busy, onAction, onEdit, onDeleteServer, align = 'end' }: Props) {
  const disabled = !!busy;
  const canStart = ['stopped', 'exited', 'error'].includes(server.status);
  const canStop = ['running', 'starting', 'restarting'].includes(server.status);
  const canRestart = server.status === 'running';
  const hasPack = Boolean(server.serverPackUrl) || Boolean(server.packReady);
  const canPrepare = ['stopped', 'exited', 'error'].includes(server.status) && hasPack;
  const [confirmState, setConfirmState] = useState<null | 'stop' | 'restart' | 'deleteServer'>(null);

  return (
    <div className={`flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      <Button
        size="sm"
        color="warning"
        variant="flat"
        startContent={<Wand2 size={16} />}
        onPress={() => onAction(server.id, 'prepare')}
        isDisabled={disabled || busy === 'prepare' || !canPrepare}
      >
        {busy === 'prepare'
          ? server.containerId
            ? 'Rebuilding…'
            : 'Preparing…'
          : server.containerId
            ? 'Rebuild'
            : 'Prepare'}
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
            <Button
              size="sm"
              color="danger"
              variant="flat"
              startContent={<Trash2 size={16} />}
              onPress={() => setConfirmState('deleteServer')}
              isDisabled={disabled || busy === 'deleteServer'}
              fullWidth
            >
              Delete server and files
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Modal isOpen={confirmState !== null} onClose={() => setConfirmState(null)} placement="center" size="sm">
        <ModalContent>
          {(onModalClose) => {
            const actionLabel =
              confirmState === 'stop'
                ? 'Stop server'
                : confirmState === 'restart'
                  ? 'Restart server'
                  : 'Delete server and files';
            const actionColor = confirmState === 'deleteServer' ? 'danger' : 'warning';
            const actionFn = () => {
              if (confirmState === 'stop') onAction(server.id, 'stop');
              if (confirmState === 'restart') onAction(server.id, 'restart');
              if (confirmState === 'deleteServer') onDeleteServer();
              setConfirmState(null);
              onModalClose();
            };

            return (
              <>
                <ModalHeader>{actionLabel}</ModalHeader>
                <ModalBody className="text-sm">
                  {confirmState === 'deleteServer' && 'This permanently deletes the server and all its files, including worlds, server packs, downloads, and snapshots. This cannot be undone.'}
                  {confirmState !== 'deleteServer' && 'Are you sure you want to proceed?'}
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onModalClose}>
                    Cancel
                  </Button>
                  <Button color={actionColor} onPress={actionFn}>
                    {confirmState === 'deleteServer' ? 'Delete server and files' : 'Confirm'}
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
