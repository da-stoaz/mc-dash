import { Chip } from '@heroui/react';
import { CircleAlert, CircleCheck, CircleOff, Loader, Power, type LucideIcon } from 'lucide-react';
import { formatServerStatus, statusColor, type ServerRecord } from '../lib/serverTypes';

const statusIcon: Record<ServerRecord['status'], LucideIcon> = {
  error: CircleAlert,
  exited: CircleOff,
  creating: Loader,
  starting: Loader,
  restarting: Loader,
  stopping: Loader,
  stopped: Power,
  running: CircleCheck,
};

export function ServerStatusChip({ server }: { server: ServerRecord }) {
  const Icon = statusIcon[server.status];
  const transitioning = ['creating', 'starting', 'restarting', 'stopping'].includes(server.status);

  return (
    <Chip
      color={statusColor[server.status]}
      variant="flat"
      size="sm"
      className="gap-1"
      startContent={<Icon size={13} aria-hidden="true" className={transitioning ? 'animate-spin motion-reduce:animate-none' : undefined} />}
    >
      {formatServerStatus(server.status, server.exitCode)}
    </Chip>
  );
}
