import { Button, Card, CardBody, CardHeader } from '@heroui/react';
import { Pencil } from 'lucide-react';
import type { ServerRecord } from '../../lib/serverTypes';

type QuickSettingsCardProps = {
  server: ServerRecord;
  onEdit: () => void;
};

export function QuickSettingsCard({ server, onEdit }: QuickSettingsCardProps) {
  const items: { label: string; value: string; capitalize?: boolean }[] = [
    { label: 'Game mode', value: server.game.gameMode ?? 'survival', capitalize: true },
    { label: 'Render distance', value: `${server.game.renderDistance ?? 10} chunks` },
    { label: 'Max RAM', value: `${server.resources.maxRamMb} MB` },
    { label: 'CPU cap', value: server.resources.cpuLimit ? `${server.resources.cpuLimit} cores` : 'Unlimited' },
    { label: 'Port', value: String(server.serverPort) },
    { label: 'Seed', value: server.game.seed || 'Random' },
  ];

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center justify-between">
        <div className="text-lg font-semibold">Settings</div>
        <Button size="sm" variant="bordered" startContent={<Pencil size={14} />} onPress={onEdit}>
          Edit
        </Button>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-2 gap-3">
          {items.map((item) => (
            <div key={item.label} className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="text-xs uppercase tracking-wide muted">{item.label}</div>
              <div className={`mt-1 text-base font-semibold break-all ${item.capitalize ? 'capitalize' : ''}`}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}