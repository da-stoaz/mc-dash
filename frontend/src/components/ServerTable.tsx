import Link from 'next/link';
import { Card, CardBody, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow, Chip, Tooltip } from '@heroui/react';
import { ServerRecord, statusColor, formatServerStatus } from '../lib/serverTypes';
import { ActionButtons } from './ActionButtons';
import { CopyButton } from './CopyButton';
import { UsageCell } from './UsageCell';
import { SleepChip } from './SleepChip';
import { formatHostname, useRouterDomain } from '../lib/routerDomain';
import { CircleAlert, CircleCheck, CircleOff, Loader, Power, type LucideIcon } from 'lucide-react';

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

// Long hostnames are truncated, with the full value on hover and a copy button.
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

function PlayerCount({ server }: { server: ServerRecord }) {
  const current = ['stopped', 'exited'].includes(server.status) ? 0
    : server.status === 'running' ? server.players : null;
  return <span className="tabular-nums whitespace-nowrap" title={current == null ? 'Player count unavailable' : undefined}>
    {current ?? '—'}/{server.maxPlayers ?? '—'}
  </span>;
}

function GameSummary({ server }: { server: ServerRecord }) {
  const game = server.game;
  return <div className="flex flex-col gap-1">
    {game.gameMode && <span className="capitalize">{game.gameMode}</span>}
    {game.renderDistance != null && <span className="muted text-xs">{game.renderDistance} chunks</span>}
    {!game.gameMode && game.renderDistance == null && <span className="muted text-xs">Not available</span>}
  </div>;
}

// Phone rendering of one server. The table needs ~900px before its seven
// columns stop colliding, so below md each row becomes a card: identity and
// status on top, the columns still worth showing as a label/value grid, then
// the same actions the table row carries.
function ServerCard({
  server,
  routerDomain,
  actionLoading,
  onAction,
  onEdit,
  onDeleteServer,
}: { server: ServerRecord; routerDomain: string | undefined } & Pick<
  Props,
  'actionLoading' | 'onAction' | 'onEdit' | 'onDeleteServer'
>) {
  const hostname = formatHostname(server.subdomain, routerDomain);

  return (
    <Card shadow="sm" className="bg-white/5 border border-white/10">
      <CardBody className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col leading-tight">
            <Link
              href={`/servers/${server.id}`}
              className="text-base font-semibold hover:text-cyan-200 transition-colors truncate"
            >
              {server.name}
            </Link>
            {hostname && (
              <div className="flex min-w-0 items-center gap-1 text-xs">
                <span className="muted truncate">{hostname}</span>
                <CopyButton value={hostname} label={`Copy hostname for ${server.name}`} compact />
              </div>
            )}
            <span className="muted font-mono text-xs">{server.id.slice(0, 8)}</span>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Chip color={statusColor[server.status]} variant="flat" size="sm">
              {formatServerStatus(server.status, server.exitCode)}
            </Chip>
            {server.restartRequired && (
              <Chip color="warning" variant="flat" size="sm">
                Restart required
              </Chip>
            )}
            <SleepChip server={server} />
          </div>
        </div>

        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <span className="muted">Players</span>
          <span className="text-right"><PlayerCount server={server} /></span>
          <span className="muted">Port</span>
          <span className="text-right">{server.serverPort}</span>
          <span className="muted">Usage</span>
          <span className="text-right">
            <UsageCell server={server} compact />
          </span>
          <span className="muted">Game</span>
          <div className="text-right"><GameSummary server={server} /></div>
        </div>

        <ActionButtons
          server={server}
          busy={actionLoading[server.id]}
          onAction={onAction}
          onEdit={() => onEdit(server)}
          onDeleteServer={() => onDeleteServer(server.id)}
          align="start"
        />
      </CardBody>
    </Card>
  );
}

type Props = {
  servers: ServerRecord[];
  emptyContent?: string;
  actionLoading: Record<string, string>;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onEdit: (server: ServerRecord) => void;
  onDeleteServer: (id: string) => void;
};

export function ServerTable({
  servers,
  emptyContent = 'No servers yet.',
  actionLoading,
  onAction,
  onEdit,
  onDeleteServer,
}: Props) {
  const routerDomain = useRouterDomain();

  return (
    <>
      {/* Phones: stacked cards. The table below is hidden at this width. */}
      <div className="space-y-3 md:hidden">
        {servers.length === 0 ? (
          <Card shadow="sm" className="bg-white/5 border border-white/10">
            <CardBody className="text-sm muted">{emptyContent}</CardBody>
          </Card>
        ) : (
          servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              routerDomain={routerDomain}
              actionLoading={actionLoading}
              onAction={onAction}
              onEdit={onEdit}
              onDeleteServer={onDeleteServer}
            />
          ))
        )}
      </div>

      <Card shadow="sm" className="max-md:hidden bg-white/5 border border-white/10">
        <Table aria-label="Servers" removeWrapper>
          <TableHeader>
            <TableColumn>Name</TableColumn>
            <TableColumn>Status</TableColumn>
            <TableColumn>Players</TableColumn>
            <TableColumn>Port</TableColumn>
            <TableColumn width={160}>Usage</TableColumn>
            <TableColumn>Game</TableColumn>
            <TableColumn align="end" width={168}>Actions</TableColumn>
          </TableHeader>
          <TableBody emptyContent={emptyContent} items={servers}>
            {(server) => {
              const StatusIcon = statusIcon[server.status];
              return (
                <TableRow key={server.id}>
                  <TableCell>
                    <ServerNameCell server={server} routerDomain={routerDomain} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Chip
                        color={statusColor[server.status]}
                        variant="flat"
                        size="sm"
                        startContent={
                          <StatusIcon
                            size={13}
                            className={server.status === 'starting' || server.status === 'restarting' ? 'animate-spin' : undefined}
                          />
                        }
                      >
                        {formatServerStatus(server.status, server.exitCode)}
                      </Chip>
                      <SleepChip server={server} />
                      {server.restartRequired && (
                        <Chip color="warning" variant="flat" size="sm">
                          Restart required
                        </Chip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PlayerCount server={server} />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{server.serverPort}</span>
                  </TableCell>
                  <TableCell>
                    <UsageCell server={server} />
                  </TableCell>
                  <TableCell>
                    <GameSummary server={server} />
                  </TableCell>
                  <TableCell>
                    <ActionButtons
                      server={server}
                      busy={actionLoading[server.id]}
                      onAction={onAction}
                      onEdit={() => onEdit(server)}
                      onDeleteServer={() => onDeleteServer(server.id)}
                    />
                  </TableCell>
                </TableRow>
              );
            }}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
