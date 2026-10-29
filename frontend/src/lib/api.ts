export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api';

// Event other components (AuthGate) listen for to drop back to the login screen
// when the session is missing or expired.
export const UNAUTHORIZED_EVENT = 'mcdash:unauthorized';

// Wrapper around fetch that always sends the session cookie and broadcasts a
// 401 so the app can re-prompt for login.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: 'include', ...init });
  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return res;
}

/** Long server mutations run as backend jobs. Poll their original result rather
 * than holding a connection through Next/Cloudflare or replaying the mutation.
 */
export async function apiOperation(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Prefer', 'respond-async');
  const response = await apiFetch(input, { ...init, headers });
  if (response.status !== 202) return response;
  const accepted = await response.json() as { operationId: string; statusUrl: string };
  if (!accepted.operationId || !accepted.statusUrl?.startsWith('/servers/')) {
    throw new Error('The server did not return an operation status. Check the server before retrying.');
  }
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 750));
    let status: Response;
    try { status = await apiFetch(`${API_BASE}${accepted.statusUrl}`, { cache: 'no-store' }); }
    catch { throw new Error('Cannot check progress. The operation may still be running; refresh before retrying.'); }
    if (!status.ok) throw new Error('Cannot check progress. The operation may still be running; refresh before retrying.');
    const job = await status.json() as { status: string; httpStatus: number; body: unknown };
    if (job.status === 'running') continue;
    return new Response(JSON.stringify(job.body), { status: job.httpStatus, headers: { 'Content-Type': 'application/json' } });
  }
}
