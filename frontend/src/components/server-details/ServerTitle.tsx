import { Chip } from '@heroui/react';
import type { ServerRecord } from '../../lib/serverTypes';
import { statusColor, statusLabel } from '../../lib/serverTypes';
import { CopyButton } from '../CopyButton';
import { formatHostname, useRouterDomain } from '../../lib/routerDomain';

type ServerTitleProps = {
  server: ServerRecord;
};

export function ServerTitle({ server }: ServerTitleProps) {
  const routerDomain = useRouterDomain();
  const hostname = formatHostname(server.subdomain, routerDomain);

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <div className="text-2xl sm:text-3xl font-semibold tracking-tight break-words">{server.name}</div>
        <div className="muted text-sm break-all">{server.id}</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="muted">Hostname</span>
          {hostname ? (
            <>
              <span className="font-mono text-sm break-all">{hostname}</span>
              <CopyButton value={hostname} label="Copy hostname" />
            </>
          ) : (
            <span className="muted">Not configured</span>
          )}
        </div>
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
