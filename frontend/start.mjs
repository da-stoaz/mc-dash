// Production entry point for the published frontend image.
//
// `next build` compiles the /api rewrite from next.config.ts into
// .next/routes-manifest.json, and `next start` reads only that manifest. A
// registry image is built once for every host, so before starting, point its
// /api rewrite at this host's backend (MC_DASH_BACKEND_URL at runtime).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(appRoot, '.next', 'routes-manifest.json');

const backend = new URL(process.env.MC_DASH_BACKEND_URL || 'http://127.0.0.1:4000');
if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password ||
    backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('MC_DASH_BACKEND_URL must be an HTTP(S) origin without credentials, path, query, or fragment');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { rewrites } = manifest;
const all = Array.isArray(rewrites)
  ? rewrites
  : [...(rewrites?.beforeFiles ?? []), ...(rewrites?.afterFiles ?? []), ...(rewrites?.fallback ?? [])];
const api = all.filter(rewrite => rewrite.source === '/api/:path*');
if (api.length !== 1) {
  throw new Error(`Expected one /api rewrite in ${manifestPath}, found ${api.length}`);
}
const destination = `${backend.origin}/:path*`;
if (api[0].destination !== destination) {
  api[0].destination = destination;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
console.log(`[mc-dash] /api -> ${backend.origin}`);

// Hand over to Next's own CLI in this process, so it receives signals directly.
process.argv = [process.argv[0], path.join(appRoot, 'node_modules/next/dist/bin/next'), 'start', ...process.argv.slice(2)];
await import('next/dist/bin/next');
