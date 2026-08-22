import { API_BASE, apiFetch } from './api';
import { extractApiErrorMessageFromText, getApiErrorMessage } from './apiErrors';

/**
 * Server packs run to hundreds of megabytes, and MC Dash is usually reached
 * through a proxy that caps request bodies — Cloudflare Tunnel refuses anything
 * over 100 MB on its cheaper plans, and rejects on Content-Length before reading
 * a byte, so a single-request upload simply parks at 1% with no error to show.
 *
 * So the file is sliced here and sent as a series of small requests that no
 * proxy objects to. The backend appends them to one file and hands it back as
 * an upload id, which the create / import / replace-pack calls then reference
 * in place of the file itself.
 */

// Deliberately well under the 100 MB ceiling: the margin covers a proxy
// configured tighter than the default, and smaller slices mean a retry after a
// dropped connection costs seconds rather than minutes.
const FALLBACK_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS_PER_CHUNK = 3;

export interface ChunkedUploadOptions {
  // Fractional progress, 0..1. Reported per chunk *and* within a chunk, so the
  // bar keeps moving on a slow link instead of stepping once per slice.
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAbortedError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function putChunk(
  url: string,
  body: Blob,
  onBytes: (loaded: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort);
    const done = () => signal?.removeEventListener('abort', abort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onBytes(event.loaded);
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(extractApiErrorMessageFromText(xhr.responseText || '', 'Upload failed')));
    };
    xhr.onerror = () => {
      done();
      reject(new Error('Connection lost during upload'));
    };
    xhr.onabort = () => {
      done();
      reject(new UploadAbortedError());
    };
    xhr.send(body);
  });
}

/**
 * Uploads `file` in slices and resolves with the id to hand to whichever route
 * consumes it. On any failure the half-finished session is discarded server-side
 * so an abandoned attempt doesn't sit on disk until the sweeper runs.
 */
export async function uploadInChunks(file: File, options: ChunkedUploadOptions = {}): Promise<string> {
  const { onProgress, signal } = options;

  const beginRes = await apiFetch(`${API_BASE}/servers/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size }),
  });
  if (!beginRes.ok) {
    throw new Error(await getApiErrorMessage(beginRes, 'Could not start the upload'));
  }
  const { id, chunkSize } = (await beginRes.json()) as { id: string; chunkSize?: number };
  const sliceBytes = chunkSize && chunkSize > 0 ? chunkSize : FALLBACK_CHUNK_BYTES;

  try {
    let uploaded = 0;
    let index = 0;
    for (let offset = 0; offset < file.size; offset += sliceBytes) {
      if (signal?.aborted) throw new UploadAbortedError();
      const slice = file.slice(offset, Math.min(offset + sliceBytes, file.size));
      const base = uploaded;

      let attempt = 0;
      for (;;) {
        try {
          await putChunk(
            `${API_BASE}/servers/uploads/${id}/${index}`,
            slice,
            (loaded) => onProgress?.(Math.min(1, (base + loaded) / file.size)),
            signal
          );
          break;
        } catch (err) {
          if (err instanceof UploadAbortedError) throw err;
          attempt += 1;
          if (attempt >= MAX_ATTEMPTS_PER_CHUNK) throw err;
          // The chunk endpoint ignores a slice it already stored, so replaying
          // one after a lost response is safe rather than duplicating bytes.
          onProgress?.(base / file.size);
          await delay(500 * attempt);
        }
      }

      uploaded += slice.size;
      index += 1;
      onProgress?.(Math.min(1, uploaded / file.size));
    }

    const completeRes = await apiFetch(`${API_BASE}/servers/uploads/${id}/complete`, { method: 'POST' });
    if (!completeRes.ok) {
      throw new Error(await getApiErrorMessage(completeRes, 'Upload did not finish'));
    }
    return id;
  } catch (err) {
    apiFetch(`${API_BASE}/servers/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}
