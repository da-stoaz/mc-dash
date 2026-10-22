import { useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Dropdown,
  DropdownMenu,
  DropdownItem,
  DropdownTrigger,
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

  const menuItems = [
    { key: 'edit', label: 'Edit', icon: <Pencil size={16} /> },
    ...(canRestart ? [{ key: 'restart', label: 'Restart', icon: <RefreshCw size={16} /> }] : []),
    ...(canPrepare && server.containerId ? [{ key: 'prepare', label: 'Rebuild', icon: <Wand2 size={16} /> }] : []),
    { key: 'deleteServer', label: 'Delete server and files', icon: <Trash2 size={16} /> },
  ];
  const preparing = busy === 'prepare' || server.status === 'creating';
  const stopping = busy === 'stop' || server.status === 'stopping';
  const restarting = busy === 'restart';
  const needsSetup = canStart && !server.containerId && !hasPack;
  const needsPrepare = canStart && !server.containerId && hasPack;
  const primaryLabel = preparing ? (server.containerId ? 'Rebuilding…' : 'Preparing…')
    : stopping ? 'Stopping…' : restarting ? 'Restarting…'
    : busy === 'start' ? 'Starting…' : canStop ? 'Stop'
    : needsPrepare ? 'Prepare' : needsSetup ? 'Set up' : 'Start';

  return (
    <div className={`flex items-center gap-2 whitespace-nowrap ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      <Button
        as={needsSetup ? Link : 'button'}
        href={needsSetup ? `/servers/${server.id}` : undefined}
        size="sm"
        className="min-w-24"
        color={canStop || stopping || restarting ? 'default' : needsPrepare || preparing ? 'warning' : 'success'}
        variant="flat"
        startContent={canStop || stopping ? <Square size={16} /> : needsPrepare || preparing ? <Wand2 size={16} /> : <Play size={16} />}
        onPress={() => {
          if (canStop) setConfirmState('stop');
          else if (!needsSetup) onAction(server.id, needsPrepare ? 'prepare' : 'start');
        }}
        isDisabled={disabled || (!canStart && !canStop)}
      >
        {primaryLabel}
      </Button>
      <Dropdown placement="bottom-end">
        <DropdownTrigger>
          <Button size="sm" variant="flat" isIconOnly aria-label={`More actions for ${server.name}`} isDisabled={disabled}>
            <MoreHorizontal size={18} />
          </Button>
        </DropdownTrigger>
        <DropdownMenu aria-label={`Actions for ${server.name}`} items={menuItems} onAction={key => {
          if (key === 'edit') onEdit();
          if (key === 'prepare') onAction(server.id, 'prepare');
          if (key === 'restart' || key === 'deleteServer') setConfirmState(key);
        }}>
          {item => <DropdownItem key={item.key} startContent={item.icon}
            color={item.key === 'deleteServer' ? 'danger' : 'default'}
            className={item.key === 'deleteServer' ? 'text-danger' : undefined}
            showDivider={item.key === 'prepare'}>
            {item.label}
          </DropdownItem>}
        </DropdownMenu>
      </Dropdown>

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
