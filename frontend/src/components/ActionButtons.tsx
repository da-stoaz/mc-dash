import { ChangeEvent, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Tooltip } from '@heroui/react';
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
      <Tooltip content="Upload server pack zip">
        <Button size="sm" variant="flat" onPress={() => document.getElementById(`file-${server.id}`)?.click()} isDisabled={disabled || busy === 'upload'}>
          {busy === 'upload' ? 'Uploading…' : 'Upload'}
        </Button>
      </Tooltip>
      <Button size="sm" color="warning" variant="flat" onPress={() => onAction(server.id, 'prepare')} isDisabled={disabled || busy === 'prepare'}>
        {busy === 'prepare' ? 'Preparing…' : 'Prepare'}
      </Button>
      <Button size="sm" color="success" variant="flat" onPress={() => onAction(server.id, 'start')} isDisabled={disabled || busy === 'start'}>
        {busy === 'start' ? 'Starting…' : 'Start'}
      </Button>
      <Button size="sm" variant="flat" onPress={() => setConfirmState('stop')} isDisabled={disabled || busy === 'stop'}>
        {busy === 'stop' ? 'Stopping…' : 'Stop'}
      </Button>
      <Button size="sm" color="secondary" variant="flat" onPress={() => setConfirmState('restart')} isDisabled={disabled || busy === 'restart'}>
        {busy === 'restart' ? 'Restarting…' : 'Restart'}
      </Button>
      <Button size="sm" variant="bordered" onPress={onEdit}>
        Edit
      </Button>
      <Button size="sm" color="danger" variant="flat" isDisabled={disabled || busy === 'delete'} onPress={() => setConfirmState('delete')}>
        Delete
      </Button>

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
