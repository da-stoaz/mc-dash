// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { FRONTEND_VERSION, isNewerVersion } from '../lib/version';
import { useRuntimeConfig } from '../lib/runtimeConfig';

/**
 * The running version, so it is obvious whether an update actually landed:
 *   v1.4.0                        everything current
 *   v1.4.0 · v1.5.0 available     a newer release has been published
 *   v1.4.0 · backend v1.3.0       the two images were not updated together
 */
export function VersionBadge() {
  const config = useRuntimeConfig();
  const backend = config?.version;
  // Older backends send no version; "unknown" means it could not read its own.
  const mismatch = Boolean(backend && /^\d+\.\d+\.\d+$/.test(backend) && backend !== FRONTEND_VERSION);
  // Compare the release against whichever image is older.
  const running = mismatch && isNewerVersion(FRONTEND_VERSION, backend) ? backend : FRONTEND_VERSION;
  const latest = config?.latestVersion;
  const updateAvailable = Boolean(latest && config?.latestReleaseUrl && isNewerVersion(latest, running));

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5" data-testid="app-version">
      <span title="MC Dash version">v{FRONTEND_VERSION}</span>
      {mismatch && (
        <>
          <span aria-hidden>·</span>
          <span
            className="text-amber-300"
            title="The frontend and backend images run different versions. Pull and recreate both: docker compose pull && docker compose up -d"
          >
            backend v{backend}
          </span>
        </>
      )}
      {updateAvailable && (
        <>
          <span aria-hidden>·</span>
          <a
            href={config!.latestReleaseUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-300 underline-offset-2 hover:underline"
            title="See what changed in this release"
          >
            v{latest} available
          </a>
        </>
      )}
    </span>
  );
}
