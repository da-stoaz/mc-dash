// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { useRuntimeConfig } from './runtimeConfig';

// Build-time fallback. The backend's MC_ROUTER_DOMAIN is the source of truth
// (GET /config); this only covers the window before /config answers, and
// frontends deployed without a reachable backend.
const ENV_ROUTER_DOMAIN = process.env.NEXT_PUBLIC_ROUTER_DOMAIN || undefined;

/** Base domain servers are reachable under, e.g. `mc.example.com`. */
export function useRouterDomain(): string | undefined {
  const domain = useRuntimeConfig()?.routerDomain;
  return (typeof domain === 'string' && domain.trim()) || ENV_ROUTER_DOMAIN;
}

/** `sub.mc.example.com`, or the bare subdomain until the domain is known. */
export function formatHostname(
  subdomain: string | null | undefined,
  routerDomain: string | undefined
): string | null {
  if (!subdomain) return null;
  return routerDomain ? `${subdomain}.${routerDomain}` : subdomain;
}
