import { Button, Chip } from '@heroui/react';
import type { ServerRecord } from '../../lib/serverTypes';
import { statusColor, statusLabel } from '../../lib/serverTypes';
import { Copy } from 'lucide-react';

const ROUTER_DOMAIN = process.env.NEXT_PUBLIC_ROUTER_DOMAIN;

type ServerTitleProps = {
  server: ServerRecord;
};

export function ServerTitle({ server }: ServerTitleProps) {
  const hostname = server.subdomain
    ? ROUTER_DOMAIN
      ? `${server.subdomain}.${ROUTER_DOMAIN}`
      : server.subdomain
    : null;

  const handleCopy = async () => {
    if (!hostname) return;
    try {
      await navigator.clipboard.writeText(hostname);
    } catch {
      // Best-effort copy; ignore failures for now.
    }
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <div className="text-3xl font-semibold tracking-tight">{server.name}</div>
        <div className="muted text-sm">{server.id}</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="muted">Hostname</span>
          {hostname ? (
            <>
              <span className="font-mono text-sm">{hostname}</span>
              <Button isIconOnly size="sm" variant="light" onPress={handleCopy} aria-label="Copy hostname">
                <Copy size={14} />
              </Button>
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
