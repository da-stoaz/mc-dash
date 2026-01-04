export type ApiErrorBody = {
  error?: unknown;
  code?: unknown;
  reason?: unknown;
  details?: unknown;
};

const MAX_LEN = 180;

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string) {
  const normalized = oneLine(value);
  if (normalized.length <= MAX_LEN) return normalized;
  return normalized.slice(0, Math.max(0, MAX_LEN - 1)).trimEnd() + '…';
}

function formatDetails(details: unknown): string | undefined {
  if (!details) return undefined;
  if (typeof details === 'string') return details;
  if (typeof details === 'object') {
    const entries = Object.entries(details as Record<string, unknown>)
      .map(([key, value]) => {
        if (!value) return null;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}: ${text}`;
      })
      .filter(Boolean) as string[];
    if (entries.length) return entries.join('; ');
  }
  return undefined;
}

export function extractApiErrorMessage(body: ApiErrorBody | null | undefined, fallback?: string): string {
  const reason = body?.reason;
  if (typeof reason === 'string' && reason.trim()) return truncate(reason.replace(/^Error:\s*/i, ''));

  const details = formatDetails(body?.details);
  if (details) return truncate(details.replace(/^Error:\s*/i, ''));

  const err = body?.error;
  if (typeof err === 'string' && err.trim()) return truncate(err.replace(/^Error:\s*/i, ''));

  return fallback ?? 'Request failed';
}

export function extractApiErrorMessageFromText(text: string, fallback?: string): string {
  const trimmed = text.trim();
  if (!trimmed) return fallback ?? 'Request failed';
  try {
    const parsed = JSON.parse(trimmed) as ApiErrorBody;
    return extractApiErrorMessage(parsed, fallback);
  } catch {
    return truncate(trimmed.replace(/^Error:\s*/i, ''));
  }
}

export async function getApiErrorMessage(res: Response, fallback?: string): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const parsed = (await res.json()) as ApiErrorBody;
      return extractApiErrorMessage(parsed, fallback);
    }
    const text = await res.text();
    return extractApiErrorMessageFromText(text, fallback);
  } catch {
    return fallback ?? 'Request failed';
  }
}

