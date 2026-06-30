import { Button, Card, CardBody, CardHeader, Divider } from '@heroui/react';
import { Pencil, Server } from 'lucide-react';
import type { ServerRecord } from '../../lib/serverTypes';

const ROUTER_DOMAIN = process.env.NEXT_PUBLIC_ROUTER_DOMAIN;

type ConfigurationCardProps = {
  server: ServerRecord;
  onEdit?: () => void;
};

export function ConfigurationCard({ server, onEdit }: ConfigurationCardProps) {
  const hostname = server.subdomain
    ? ROUTER_DOMAIN
      ? `${server.subdomain}.${ROUTER_DOMAIN}`
      : server.subdomain
    : null;

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Server size={18} />
          <span>Configuration</span>
        </div>
        {onEdit && (
          <Button size="sm" variant="bordered" startContent={<Pencil size={14} />} onPress={onEdit}>
            Edit config
          </Button>
        )}
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        <div className="space-y-2">
          <div className="text-base font-semibold">Server pack</div>
          <div className="muted break-all">
            {server.serverPackUrl ? server.serverPackUrl.split(/[\\/]/).pop() : 'Not uploaded'}
          </div>
          {hostname && <div className="muted">Hostname: {hostname}</div>}
          <div className="muted">Port: {server.serverPort}</div>
          <div className="muted">
            Java image:{' '}
            {server.javaImage
              ? server.javaImage
              : server.effectiveJavaImage
                ? `Auto → ${server.effectiveJavaImage}${server.effectiveJavaSource ? ` (${server.effectiveJavaSource})` : ''}`
                : 'Auto'}
          </div>
          {!server.javaImage && (server.packRecommendedJava || server.packRecommendedJavaMajor) && (
            <div className="muted">
              Pack recommends:{' '}
              {server.packRecommendedJavaMajor ? `Java ${server.packRecommendedJavaMajor}` : 'Java ?'}
              {server.packRecommendedJava ? ` (${server.packRecommendedJava})` : ''}
            </div>
          )}
          <div className="muted">Container: {server.containerId ?? '-'}</div>
        </div>
        <Divider className="bg-white/10" />
        <div className="space-y-2">
          <div className="text-base font-semibold">Resources</div>
          <div className="muted">
            RAM: {server.resources.minRamMb}-{server.resources.maxRamMb} MB
          </div>
          <div className="muted">CPU cap: {server.resources.cpuLimit ?? '-'} cores</div>
        </div>
        <Divider className="bg-white/10" />
        <div className="space-y-2">
          <div className="text-base font-semibold">Game</div>
          <div className="muted">Mode: {server.game.gameMode ?? '-'}</div>
          <div className="muted">Difficulty: {server.game.difficulty ?? '-'}</div>
          <div className="muted">Render distance: {server.game.renderDistance ?? '-'} chunks</div>
          <div className="muted break-all">Seed: {server.game.seed || '-'}</div>
        </div>
      </CardBody>
    </Card>
  );
}
