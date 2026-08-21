'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { Check, Copy } from 'lucide-react';

type CopyButtonProps = {
  value: string;
  /** Accessible name, e.g. "Copy hostname". */
  label?: string;
  /** Shrink to the height of the adjacent text, so it can sit inline in a dense
   *  table row without setting the row height. */
  compact?: boolean;
};

// navigator.clipboard only exists in a secure context, so it is missing whenever
// the dashboard is opened over plain http on a LAN IP — the common case here.
// Fall back to the old execCommand path rather than silently doing nothing.
async function writeToClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied or insecure context; try the fallback below.
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label = 'Copy', compact = false }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = async () => {
    if (!(await writeToClipboard(value))) return;
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const iconSize = compact ? 12 : 14;

  return (
    <Tooltip content={copied ? 'Copied' : value} size="sm" delay={200} closeDelay={0}>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        onPress={handleCopy}
        aria-label={label}
        // min-h-4 opts out of the mobile touch-target floor in globals.css:
        // compact exists to match the adjacent text height, and a 40px button
        // would set the height of the dense row it sits in.
        className={compact ? 'h-4 min-h-4 w-4 min-w-4 shrink-0' : 'shrink-0'}
      >
        {copied ? <Check size={iconSize} className="text-emerald-400" /> : <Copy size={iconSize} />}
      </Button>
    </Tooltip>
  );
}
