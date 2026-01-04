export type ApiErrorBody = {
  error: string;
  code?: string;
  reason?: string;
  details?: string;
};

export class UserFacingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason?: string;
  readonly details?: string;

  constructor(opts: { error: string; code: string; status?: number; reason?: string; details?: string }) {
    super(opts.error);
    this.name = 'UserFacingError';
    this.code = opts.code;
    this.status = opts.status ?? 400;
    this.reason = opts.reason;
    this.details = opts.details;
  }
}

const MAX_REASON_LEN = 180;

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLen: number) {
  if (value.length <= maxLen) return value;
  return value.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}

function normalizeReason(value?: string) {
  if (!value) return undefined;
  const normalized = truncate(oneLine(value), MAX_REASON_LEN);
  if (!normalized) return undefined;
  return normalized;
}

function getErrCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getErrMessage(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function classifyDocker(err: unknown): { status: number; body: ApiErrorBody } | null {
  const code = getErrCode(err);
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return { status: 503, body: { error: 'Docker unavailable', code: 'DOCKER_UNAVAILABLE', reason: 'Docker is not available' } };
  }
  if (code === 'EACCES') {
    return {
      status: 503,
      body: { error: 'Docker unavailable', code: 'DOCKER_UNAVAILABLE', reason: 'Docker is not available (permission denied)' },
    };
  }

  const message = getErrMessage(err) ?? '';
  if (/Cannot connect to the Docker daemon/i.test(message) || /connect ENOENT .*docker\.sock/i.test(message)) {
    return { status: 503, body: { error: 'Docker unavailable', code: 'DOCKER_UNAVAILABLE', reason: 'Docker is not available' } };
  }

  if (/port is already allocated/i.test(message) || /Bind for .* failed: port is already allocated/i.test(message)) {
    return { status: 409, body: { error: 'Port in use', code: 'PORT_IN_USE', reason: 'Server port is already in use' } };
  }

  if (/pull access denied/i.test(message) || /manifest for .* not found/i.test(message) || /repository does not exist/i.test(message)) {
    return {
      status: 400,
      body: { error: 'Docker image unavailable', code: 'DOCKER_IMAGE_UNAVAILABLE', reason: 'Java image is not available' },
    };
  }

  return null;
}

function classifyServerPack(err: unknown): { status: number; body: ApiErrorBody } | null {
  const message = getErrMessage(err) ?? '';

  if (/Remote URLs are not supported/i.test(message)) {
    return {
      status: 400,
      body: { error: 'Unsupported server pack', code: 'PACK_REMOTE_UNSUPPORTED', reason: 'Remote URLs are not supported; upload a zip' },
    };
  }

  if (/Server pack file not found/i.test(message)) {
    return {
      status: 400,
      body: { error: 'Server pack not found', code: 'PACK_NOT_FOUND', reason: 'Server pack file not found' },
    };
  }

  if (/missing an uploaded server pack/i.test(message)) {
    return { status: 400, body: { error: 'Server pack missing', code: 'PACK_MISSING', reason: 'Server is missing an uploaded server pack' } };
  }

  if (/Could not find a start script or server\.jar/i.test(message)) {
    return {
      status: 400,
      body: { error: 'Unsupported server pack', code: 'PACK_UNSUPPORTED', reason: 'Unsupported server pack (missing start script / server.jar)' },
    };
  }

  return null;
}

export function toApiError(
  err: unknown,
  fallback: { error: string; status?: number } = { error: 'Request failed', status: 500 }
): { status: number; body: ApiErrorBody } {
  if (err instanceof UserFacingError) {
    return {
      status: err.status,
      body: {
        error: err.message,
        code: err.code,
        reason: normalizeReason(err.reason),
        details: normalizeReason(err.details),
      },
    };
  }

  const docker = classifyDocker(err);
  if (docker) return docker;

  const pack = classifyServerPack(err);
  if (pack) return pack;

  const message = getErrMessage(err);
  return {
    status: fallback.status ?? 500,
    body: {
      error: fallback.error,
      reason: normalizeReason(message),
    },
  };
}

