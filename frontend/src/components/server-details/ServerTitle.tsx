import { Chip } from '@heroui/react';
import type { ServerRecord } from '../../lib/serverTypes';
import { CopyButton } from '../CopyButton';
import { ServerStatusChip } from '../ServerStatusChip';
import { SleepChip } from '../SleepChip';
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
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight break-words">{server.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="muted">Join address</span>
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
          <ServerStatusChip server={server} />
          <SleepChip server={server} />
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
