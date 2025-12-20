import { Card, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow, Chip } from '@heroui/react';
import { ServerRecord, statusColor, statusLabel } from '../lib/serverTypes';
import { ActionButtons } from './ActionButtons';

type Props = {
  servers: ServerRecord[];
  actionLoading: Record<string, string>;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onUpload: (id: string, file: File) => void;
  onEdit: (server: ServerRecord) => void;
  onDeleteContainer: (id: string) => void;
};

export function ServerTable({ servers, actionLoading, onAction, onUpload, onEdit, onDeleteContainer }: Props) {
  return (
    <Card shadow="sm" className="bg-white/5 border border-white/10">
      <Table aria-label="Servers" removeWrapper>
        <TableHeader>
          <TableColumn>Name</TableColumn>
          <TableColumn>Status</TableColumn>
          <TableColumn>Pack</TableColumn>
          <TableColumn>Resources</TableColumn>
          <TableColumn>Game</TableColumn>
          <TableColumn align="end">Actions</TableColumn>
        </TableHeader>
        <TableBody emptyContent="No servers yet." items={servers}>
          {(server) => (
            <TableRow key={server.id}>
              <TableCell>
                <div className="flex flex-col">
                  <strong>{server.name}</strong>
                  <span className="muted text-xs">{server.id.slice(0, 8)}</span>
                </div>
              </TableCell>
              <TableCell>
                <Chip color={statusColor[server.status]} variant="flat" size="sm">
                  {statusLabel[server.status]}
                </Chip>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1 max-w-[220px]">
                  {server.packId && <span>ID {server.packId}</span>}
                  {server.packVersion && <span className="muted text-xs">v{server.packVersion}</span>}
                  {server.serverPackUrl && <span className="muted text-xs truncate">{server.serverPackUrl}</span>}
                </div>
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
                  onUpload={onUpload}
                  onEdit={() => onEdit(server)}
                  onDeleteContainer={() => onDeleteContainer(server.id)}
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
