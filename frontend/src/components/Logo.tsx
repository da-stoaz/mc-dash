'use client';

import { useId } from 'react';

type Props = {
  size?: number;
  className?: string;
};

/**
 * MC Dash mark: an isometric block in the app's cyan-to-blue brand gradient.
 *
 * Inlined rather than an <img> so it inherits size from the call site and stays
 * crisp at every scale. Gradient ids are per-instance (useId) because SVG defs
 * live in a single global namespace — two copies on one page with hardcoded ids
 * would make the second render with the first's gradients.
 */
export function Logo({ size = 24, className }: Props) {
  const id = useId();
  const top = `${id}-top`;
  const left = `${id}-left`;
  const right = `${id}-right`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role="img"
      aria-label="MC Dash"
    >
      <defs>
        <linearGradient id={top} x1="6" y1="6" x2="58" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a5f3fc" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <linearGradient id={left} x1="6" y1="21" x2="32" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0284c7" />
        </linearGradient>
        <linearGradient id={right} x1="58" y1="21" x2="32" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <path d="M32 6 58 21 32 36 6 21Z" fill={`url(#${top})`} />
      <path d="M6 21 32 36 32 58 6 43Z" fill={`url(#${left})`} />
      <path d="M58 21 32 36 32 58 58 43Z" fill={`url(#${right})`} />
    </svg>
  );
}
