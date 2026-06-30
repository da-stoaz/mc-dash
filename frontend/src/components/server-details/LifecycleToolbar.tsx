import { Button } from '@heroui/react';
import { Play, RefreshCw, Square, Wand2 } from 'lucide-react';

type LifecycleToolbarProps = {
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
};

export function LifecycleToolbar({
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
}: LifecycleToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-2">
      <Button
        size="sm"
        color="warning"
        variant="flat"
        startContent={<Wand2 size={14} />}
        onPress={onPrepare}
        isDisabled={controlsDisabled || !canPrepare}
      >
        {busy === 'prepare'
          ? hasContainer
            ? 'Rebuilding...'
            : 'Preparing...'
          : hasContainer
            ? 'Rebuild'
            : 'Prepare'}
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
  );
}
