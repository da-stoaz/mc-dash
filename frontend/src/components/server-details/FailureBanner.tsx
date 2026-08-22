'use client';

import { AlertTriangle } from 'lucide-react';

/**
 * A failed Prepare used to leave nothing behind but a red status chip: the toast
 * that carried the reason is gone in seconds, and says nothing at all to someone
 * who reloads, or who comes back to the tab later. The reason is persisted on the
 * record now, and this is where it gets read.
 *
 * Renders nothing when there is nothing wrong, so it can sit in the layout
 * unconditionally.
 */
export function FailureBanner({ message }: { message?: string | null }) {
  if (!message?.trim()) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-large border border-danger-200 bg-danger-50 px-4 py-3 text-danger-700 dark:border-danger-400/40 dark:bg-danger-500/10 dark:text-danger-300"
    >
      <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-small font-semibold">Last attempt failed</p>
        {/* Pack errors can carry a path or a long library message, so let it wrap
            rather than pushing the card into a horizontal scroll on mobile. */}
        <p className="text-small break-words opacity-90">{message}</p>
      </div>
    </div>
  );
}
