'use client';

import { Tooltip } from '@heroui/react';
import { ReactNode } from 'react';

/** Disabled native buttons don't receive hover/focus; the wrapper does. */
export function DisabledAction({ reason, label, children, className = '' }: {
  reason?: string | null;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return <Tooltip content={reason} isDisabled={!reason} delay={400} closeDelay={0} size="sm"
    classNames={{ content: 'max-w-64 px-3 py-2 text-xs text-default-500' }}>
    <span className={`inline-flex rounded-lg ${reason ? 'cursor-help' : ''} ${className}`}
      role={reason ? 'group' : undefined} aria-label={reason ? `${label} unavailable` : undefined}
      tabIndex={reason ? 0 : undefined}>
      {children}
    </span>
  </Tooltip>;
}
