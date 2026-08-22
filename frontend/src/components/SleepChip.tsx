'use client';

import { Chip, Tooltip } from '@heroui/react';
import { Moon } from 'lucide-react';
import { ServerRecord } from '../lib/serverTypes';

// A hibernated server is genuinely stopped, so its status chip says "Stopped" —
// which on its own reads as "somebody turned this off" and invites a confused
// operator to start it by hand. This chip is the difference: the server is down
// because nobody was playing, and a player joining will bring it back.
export function SleepChip({ server }: { server: ServerRecord }) {
  if (!server.hibernated) return null;

  return (
    <Tooltip
      size="sm"
      delay={200}
      closeDelay={0}
      content="Stopped automatically because nobody was playing. Its memory is fully released, and joining the server starts it again."
    >
      <Chip color="primary" variant="flat" size="sm" startContent={<Moon size={13} />} className="cursor-help">
        Sleeping
      </Chip>
    </Tooltip>
  );
}
