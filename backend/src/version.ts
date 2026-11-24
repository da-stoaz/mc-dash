// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'fs';
import path from 'path';

// The version comes from this package's own package.json: src/../package.json
// under ts-node, dist/../package.json (/app/package.json) in the image. Every
// pull request bumps it; see scripts/version.cjs at the repository root.
function readAppVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const appVersion = readAppVersion();

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** `[major, minor, patch]`, or null for anything that is not a plain release version. */
export function parseVersion(value: string | null | undefined): [number, number, number] | null {
  const match = SEMVER.exec(value?.trim() ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}
