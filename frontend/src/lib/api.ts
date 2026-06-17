export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

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
