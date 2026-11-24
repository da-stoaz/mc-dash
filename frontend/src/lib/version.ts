// SPDX-License-Identifier: AGPL-3.0-only

import packageJson from '../../package.json';

/** The dashboard's own version, from frontend/package.json at build time. */
export const FRONTEND_VERSION: string = packageJson.version;

function parse(value: string | null | undefined): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value?.trim() ?? '');
  return match ? match.slice(1).map(Number) : null;
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}
