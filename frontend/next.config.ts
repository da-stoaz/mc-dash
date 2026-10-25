import type { NextConfig } from 'next';

const appRoot = __dirname;

const backend = new URL(process.env.MC_DASH_BACKEND_URL || 'http://127.0.0.1:4000');
if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password ||
    backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('MC_DASH_BACKEND_URL must be an HTTP(S) origin without credentials, path, query, or fragment');
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: appRoot,
  turbopack: { root: appRoot },
  // The backend allows upload chunks up to 90 MiB plus 1 MiB of parsing slack.
  // Next's 10 MiB default silently truncates those proxied request bodies.
  experimental: { proxyClientMaxBodySize: '91mb' },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backend.origin}/:path*` }];
  },
};

export default nextConfig;
