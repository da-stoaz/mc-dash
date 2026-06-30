import { Button, Card, CardBody, CardHeader } from '@heroui/react';

type FirewallCardProps = {
  whitelistEnabled: boolean;
  whitelistCount: number;
  blacklistEnabled: boolean;
  blacklistCount: number;
  onManage: () => void;
};

export function FirewallCard({
  whitelistEnabled,
  whitelistCount,
  blacklistEnabled,
  blacklistCount,
  onManage,
}: FirewallCardProps) {
  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center justify-between">
        <div className="text-lg font-semibold">Firewall & access</div>
        <Button size="sm" variant="bordered" onPress={onManage}>
          Manage firewall
        </Button>
      </CardHeader>
      <CardBody className="grid gap-4 md:grid-cols-2 text-sm">
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs uppercase tracking-wide muted">Whitelist</div>
          <div className="mt-2 text-lg font-semibold">{whitelistEnabled ? 'Enabled' : 'Disabled'}</div>
          <div className="text-xs muted">{whitelistCount} allowed</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs uppercase tracking-wide muted">Player blacklist</div>
          <div className="mt-2 text-lg font-semibold">{blacklistEnabled ? 'Enabled' : 'Disabled'}</div>
          <div className="text-xs muted">{blacklistCount} blocked</div>
        </div>
      </CardBody>
    </Card>
  );
}
