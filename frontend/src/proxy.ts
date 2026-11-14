import { NextResponse, type NextRequest } from 'next/server';

// The browser always calls /api on the dashboard's own origin. Forward those
// requests to the backend named at runtime by MC_DASH_BACKEND_URL, so one
// published image works with any backend address. (A next.config rewrite would
// fix the target at build time.)
const backend = new URL(process.env.MC_DASH_BACKEND_URL || 'http://127.0.0.1:4000');
if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password ||
    backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('MC_DASH_BACKEND_URL must be an HTTP(S) origin without credentials, path, query, or fragment');
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // Concatenate rather than resolve against the origin: a path such as
  // /api//other-host must never change the destination host.
  return NextResponse.rewrite(`${backend.origin}${pathname.slice('/api'.length) || '/'}${search}`);
}

export const config = { matcher: '/api/:path*' };
