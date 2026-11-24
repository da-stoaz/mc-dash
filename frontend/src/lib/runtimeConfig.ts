// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from './api';

/** Settings only the backend's environment knows, served by GET /config. */
export type RuntimeConfig = {
  routerEnabled?: boolean;
  routerDomain?: string | null;
  routerPort?: number;
  /** Version of the running backend image. */
  version?: string;
  /** Newest published release, when the backend's update check has one. */
  latestVersion?: string | null;
  latestReleaseUrl?: string | null;
};

// Module-level cache so every component that needs /config shares one request
// and later mounts render the answer immediately.
let cached: RuntimeConfig | null = null;
let inFlight: Promise<RuntimeConfig | null> | null = null;

export function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  if (!inFlight) {
    inFlight = apiFetch(`${API_BASE}/config`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: RuntimeConfig) => {
        cached = body && typeof body === 'object' ? body : {};
        return cached;
      })
      .catch(() => {
        // Offline/401: keep whatever we have and let a later mount retry.
        inFlight = null;
        return cached;
      });
  }
  return inFlight;
}

/** GET /config, or null until it answers. */
export function useRuntimeConfig(): RuntimeConfig | null {
  const [value, setValue] = useState<RuntimeConfig | null>(cached);

  useEffect(() => {
    let active = true;
    loadRuntimeConfig().then((next) => {
      if (active) setValue(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return value;
}
