import Link from 'next/link';
import { Card, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow, Chip, Tooltip } from '@heroui/react';
import { ServerRecord, statusColor, statusLabel } from '../lib/serverTypes';
import { ActionButtons } from './ActionButtons';
import { CopyButton } from './CopyButton';
import { formatHostname, useRouterDomain } from '../lib/routerDomain';

// Hostnames and pack filenames are both longer than the column can show, so
// each is truncated with the full value on hover — and the hostname, the bit
// people actually need to hand out, gets a copy button next to it.
function ServerNameCell({ server, routerDomain }: { server: ServerRecord; routerDomain: string | undefined }) {
  const hostname = formatHostname(server.subdomain, routerDomain);

  return (
    <div className="flex flex-col max-w-[260px] leading-tight">
      <Link
        href={`/servers/${server.id}`}
        className="text-base font-semibold hover:text-cyan-200 transition-colors truncate"
        title={server.name}
      >
        {server.name}
      </Link>
      {/* Hostname and short id share one line: three stacked lines made every
          row taller than the action buttons needed. */}
      <div className="flex items-center gap-1 min-w-0 text-xs">
        {hostname && (
          <>
            <Tooltip content={hostname} size="sm" delay={200} closeDelay={0}>
              <span className="muted truncate">{hostname}</span>
            </Tooltip>
            <CopyButton value={hostname} label={`Copy hostname for ${server.name}`} compact />
            <span className="muted shrink-0">·</span>
          </>
        )}
        <span className="muted shrink-0 font-mono">{server.id.slice(0, 8)}</span>
      </div>
    </div>
  );
}

type Props = {
  servers: ServerRecord[];
  actionLoading: Record<string, string>;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onEdit: (server: ServerRecord) => void;
  onDeleteContainer: (id: string) => void;
  onDeleteServer: (id: string) => void;
};

export function ServerTable({ servers, actionLoading, onAction, onEdit, onDeleteContainer, onDeleteServer }: Props) {
  const routerDomain = useRouterDomain();

  return (
    <Card shadow="sm" className="bg-white/5 border border-white/10">
      <Table aria-label="Servers" removeWrapper>
        <TableHeader>
          <TableColumn>Name</TableColumn>
          <TableColumn>Status</TableColumn>
          <TableColumn>Server pack</TableColumn>
          <TableColumn>Port</TableColumn>
          <TableColumn>Resources</TableColumn>
          <TableColumn>Game</TableColumn>
          <TableColumn align="end">Actions</TableColumn>
        </TableHeader>
        <TableBody emptyContent="No servers yet." items={servers}>
          {(server) => (
            <TableRow key={server.id}>
              <TableCell>
                <ServerNameCell server={server} routerDomain={routerDomain} />
              </TableCell>
              <TableCell>
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
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1 max-w-[220px]">
                  {server.serverPackName ? (
                    <Tooltip content={server.serverPackName} size="sm" delay={200} closeDelay={0}>
                      <span className="muted text-xs truncate">{server.serverPackName}</span>
                    </Tooltip>
                  ) : server.packReady ? (
                    <span className="muted text-xs">Imported from snapshot</span>
                  ) : (
                    <span className="muted text-xs">No pack uploaded</span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <span className="text-sm">{server.serverPort}</span>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span>
                    {server.resources.minRamMb}–{server.resources.maxRamMb} MB
                  </span>
                  {server.resources.cpuLimit && <span className="muted text-xs">{server.resources.cpuLimit} CPU</span>}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  {server.game.gameMode && <span>{server.game.gameMode}</span>}
                  {server.game.renderDistance && <span className="muted text-xs">{server.game.renderDistance} chunks</span>}
                  {server.game.seed && <span className="muted text-xs truncate">{server.game.seed}</span>}
                </div>
              </TableCell>
              <TableCell>
                <ActionButtons
                  server={server}
                  busy={actionLoading[server.id]}
                  onAction={onAction}
                  onEdit={() => onEdit(server)}
                  onDeleteContainer={() => onDeleteContainer(server.id)}
                  onDeleteServer={() => onDeleteServer(server.id)}
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
