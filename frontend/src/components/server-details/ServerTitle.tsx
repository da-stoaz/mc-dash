import { Chip } from '@heroui/react';
import type { ServerRecord } from '../../lib/serverTypes';
import { statusColor, statusLabel } from '../../lib/serverTypes';

type ServerTitleProps = {
  server: ServerRecord;
};

export function ServerTitle({ server }: ServerTitleProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <div className="text-3xl font-semibold tracking-tight">{server.name}</div>
        <div className="muted text-sm">{server.id}</div>
        <div className="flex flex-wrap gap-2">
          <Chip color={statusColor[server.status]} variant="flat" size="sm">
            {statusLabel[server.status]}
          </Chip>
          {server.restartRequired && (
            <Chip color="warning" variant="flat" size="sm">
              Restart required
            </Chip>
          )}
        </div>
      </div>
    </div>
  );
}
