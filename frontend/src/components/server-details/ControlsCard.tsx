import { Button, Card, CardBody, CardHeader } from '@heroui/react';
import { Pencil, Play, RefreshCw, Square, Trash2, Wand2 } from 'lucide-react';

type ControlsCardProps = {
  busy?: string;
  canPrepare: boolean;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  controlsDisabled: boolean;
  hasContainer: boolean;
  onPrepare: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onEdit: () => void;
  onDeleteContainer: () => void;
  onDeleteServer: () => void;
};

export function ControlsCard({
  busy,
  canPrepare,
  canStart,
  canStop,
  canRestart,
  controlsDisabled,
  hasContainer,
  onPrepare,
  onStart,
  onStop,
  onRestart,
  onEdit,
  onDeleteContainer,
  onDeleteServer,
}: ControlsCardProps) {
  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center justify-between">
        <div className="text-lg font-semibold">Controls</div>
        <div className="text-xs muted">Lifecycle, config, and maintenance actions</div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">Lifecycle</div>
                <div className="text-xs muted">Prepare, start, stop, restart</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  color="warning"
                  variant="flat"
                  startContent={<Wand2 size={14} />}
                  onPress={onPrepare}
                  isDisabled={controlsDisabled || !canPrepare}
                >
                  {busy === 'prepare' ? 'Preparing...' : 'Prepare'}
                </Button>
                <Button
                  size="sm"
                  color="success"
                  variant="flat"
                  startContent={<Play size={14} />}
                  onPress={onStart}
                  isDisabled={controlsDisabled || !canStart || !hasContainer}
                >
                  {busy === 'start' ? 'Starting...' : 'Start'}
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<Square size={14} />}
                  onPress={onStop}
                  isDisabled={controlsDisabled || !canStop}
                >
                  {busy === 'stop' ? 'Stopping...' : 'Stop'}
                </Button>
                <Button
                  size="sm"
                  color="secondary"
                  variant="flat"
                  startContent={<RefreshCw size={14} />}
                  onPress={onRestart}
                  isDisabled={controlsDisabled || !canRestart}
                >
                  {busy === 'restart' ? 'Restarting...' : 'Restart'}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Configuration</div>
                <div className="text-xs muted">Resources, game rules, Java image</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="bordered" startContent={<Pencil size={14} />} onPress={onEdit}>
                  Edit config
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4">
            <div className="text-sm font-semibold text-rose-100">Danger zone</div>
            <div className="text-xs muted">Destructive actions for this server</div>
            <div className="mt-3 flex flex-col gap-2">
              <Button
                size="sm"
                color="danger"
                variant="flat"
                startContent={<Trash2 size={14} />}
                onPress={onDeleteContainer}
                isDisabled={controlsDisabled || busy === 'delete'}
                fullWidth
              >
                Delete container
              </Button>
              <Button
                size="sm"
                color="danger"
                variant="flat"
                startContent={<Trash2 size={14} />}
                onPress={onDeleteServer}
                isDisabled={controlsDisabled || busy === 'deleteServer'}
                fullWidth
              >
                Delete server
              </Button>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
