import type { NextConfig } from 'next';

const appRoot = __dirname;

const nextConfig: NextConfig = {
  // The production image ships only the traced server (.next/standalone) plus
  // static assets, not the full build tree with dev dependencies. See Dockerfile.
  output: 'standalone',
  outputFileTracingRoot: appRoot,
  turbopack: { root: appRoot },
  // /api is forwarded by src/proxy.ts. The backend allows upload chunks up to
  // 90 MiB plus 1 MiB of parsing slack; Next's 10 MiB default silently
  // truncates those proxied request bodies.
  experimental: { proxyClientMaxBodySize: '91mb' },
};

export default nextConfig;
