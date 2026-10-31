import { Button } from '@heroui/react';
import { Play, RefreshCw, Square, Wand2 } from 'lucide-react';
import { DisabledAction } from '../DisabledAction';

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
  const pendingReason = controlsDisabled ? 'Wait for the current server operation to finish.' : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(canPrepare || busy === 'prepare') && <DisabledAction label={hasContainer ? 'Rebuild' : 'Prepare'} reason={pendingReason ?? (!canPrepare ? 'Stop the server before preparing it.' : null)}><Button
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
      </Button></DisabledAction>}
      {(canStart || busy === 'start') && <DisabledAction label="Start" reason={pendingReason ?? (!hasContainer ? 'Prepare the server before starting it.' : !canStart ? 'The server is not ready to start yet.' : null)}><Button
        size="sm"
        color="success"
        variant="flat"
        startContent={<Play size={14} />}
        onPress={onStart}
        isDisabled={controlsDisabled || !canStart || !hasContainer}
      >
        {busy === 'start' ? 'Starting...' : 'Start'}
      </Button></DisabledAction>}
      {(canStop || busy === 'stop') && <DisabledAction label="Stop" reason={pendingReason ?? (!canStop ? 'The server is already stopping or stopped.' : null)}><Button
        size="sm"
        variant="flat"
        startContent={<Square size={14} />}
        onPress={onStop}
        isDisabled={controlsDisabled || !canStop}
      >
        {busy === 'stop' ? 'Stopping...' : 'Stop'}
      </Button></DisabledAction>}
      {(canRestart || busy === 'restart') && <DisabledAction label="Restart" reason={pendingReason ?? (!canRestart ? 'The server must be running before restarting it.' : null)}><Button
        size="sm"
        color="secondary"
        variant="flat"
        startContent={<RefreshCw size={14} />}
        onPress={onRestart}
        isDisabled={controlsDisabled || !canRestart}
      >
        {busy === 'restart' ? 'Restarting...' : 'Restart'}
      </Button></DisabledAction>}
    </div>
  );
}
