import Link from 'next/link';
import { Card, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow, Chip } from '@heroui/react';
import { ServerRecord, statusColor, statusLabel } from '../lib/serverTypes';
import { ActionButtons } from './ActionButtons';

const ROUTER_DOMAIN = process.env.NEXT_PUBLIC_ROUTER_DOMAIN;

type Props = {
  servers: ServerRecord[];
  actionLoading: Record<string, string>;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onEdit: (server: ServerRecord) => void;
  onDeleteContainer: (id: string) => void;
  onDeleteServer: (id: string) => void;
};

export function ServerTable({ servers, actionLoading, onAction, onEdit, onDeleteContainer, onDeleteServer }: Props) {
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
                <div className="flex flex-col">
                  <Link href={`/servers/${server.id}`} className="font-semibold hover:text-cyan-200 transition-colors">
                    {server.name}
                  </Link>
                  {server.subdomain && (
                    <span className="muted text-xs">
                      {ROUTER_DOMAIN ? `${server.subdomain}.${ROUTER_DOMAIN}` : server.subdomain}
                    </span>
                  )}
                  <span className="muted text-xs">{server.id.slice(0, 8)}</span>
                </div>
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
                  {server.serverPackUrl ? (
                    <span className="muted text-xs truncate">
                      {server.serverPackUrl.split(/[\\/]/).pop()}
                    </span>
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
