'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from './api';

// Build-time fallback. The backend's MC_ROUTER_DOMAIN is the source of truth
// (fetched below); this only covers the window before /config answers, and
// frontends deployed without a reachable backend.
const ENV_ROUTER_DOMAIN = process.env.NEXT_PUBLIC_ROUTER_DOMAIN || undefined;

// Module-level cache so the handful of components that show hostnames share one
// request and later mounts render the real domain immediately.
let cachedDomain: string | undefined = ENV_ROUTER_DOMAIN;
let inFlight: Promise<string | undefined> | null = null;

function loadRouterDomain(): Promise<string | undefined> {
  if (!inFlight) {
    inFlight = apiFetch(`${API_BASE}/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const domain = typeof body?.routerDomain === 'string' ? body.routerDomain.trim() : '';
        if (domain) cachedDomain = domain;
        return cachedDomain;
      })
      .catch(() => {
        // Offline/401: keep whatever we have and let a later mount retry.
        inFlight = null;
        return cachedDomain;
      });
  }
  return inFlight;
}

/** Base domain servers are reachable under, e.g. `mc.example.com`. */
export function useRouterDomain(): string | undefined {
  const [domain, setDomain] = useState<string | undefined>(cachedDomain);

  useEffect(() => {
    let active = true;
    loadRouterDomain().then((value) => {
      if (active) setDomain(value);
    });
    return () => {
      active = false;
    };
  }, []);

  return domain;
}

/** `sub.mc.example.com`, or the bare subdomain until the domain is known. */
export function formatHostname(
  subdomain: string | null | undefined,
  routerDomain: string | undefined
): string | null {
  if (!subdomain) return null;
  return routerDomain ? `${subdomain}.${routerDomain}` : subdomain;
}
