import { Card, CardBody, CardHeader } from '@heroui/react';
import { LogStream } from '../LogStream';

type LogsCardProps = {
  serverId: string;
  apiBase: string;
};

export function LogsCard({ serverId, apiBase }: LogsCardProps) {
  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="text-lg font-semibold">Live logs</CardHeader>
      <CardBody>
        <LogStream serverId={serverId} apiBase={apiBase} />
      </CardBody>
    </Card>
  );
}
