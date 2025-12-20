import { Button, Card, CardBody, Chip } from '@heroui/react';
import { ServerStatus, statusColor, statusLabel } from '../lib/serverTypes';

type Props = {
  counts: Record<ServerStatus, number>;
  loading: boolean;
  onRefresh: () => void;
};

export function StatusBar({ counts, loading, onRefresh }: Props) {
  return (
    <Card shadow="sm" className="mb-4 bg-white/5 border border-white/10">
      <CardBody className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(counts).map(([status, count]) => (
            <Chip key={status} color={statusColor[status as ServerStatus]} variant="flat">
              {statusLabel[status as ServerStatus]}: {count}
            </Chip>
          ))}
        </div>
        <div className="ml-auto">
          <Button size="sm" variant="flat" onPress={onRefresh} isDisabled={loading}>
            Refresh
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
