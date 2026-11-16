/**
 * JSON API client. Every call resolves to the parsed body or throws ApiError
 * with the server's `{ error }` message, so pages can show it directly.
 */
import { emit } from './store.js';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, { signal, quiet401 = false } = {}) {
  const init = { method, credentials: 'same-origin', signal, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('You appear to be offline. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !quiet401) emit('unauthorized');
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body = {}, options) => request('POST', path, body, options),
  put: (path, body = {}, options) => request('PUT', path, body, options),
  patch: (path, body = {}, options) => request('PATCH', path, body, options),
  del: (path, options) => request('DELETE', path, undefined, options),

  /** Upload raw bytes (e.g. an audio recording). */
  async upload(path, blob, headers = {}) {
    const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type.split(';')[0] || 'application/octet-stream', ...headers }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || 'Upload failed', res.status, data);
    return data;
  },

  /**
   * Upload straight to file storage (when the server has it): ask Citrus for a pass, send the file to the store,
   * then hand back the receipt. Big files never pass through Citrus this way. `fields` go with the first step.
   */
  async uploadDirect(startPath, finishPath, blob, fields = {}) {
    const type = blob.type.split(';')[0] || 'application/octet-stream';
    const start = await request('POST', startPath, { size: blob.size, type, ...fields });
    let res;
    try {
      // A presigned address carries its own signature; an older store's pass is a token to send along.
      res = await fetch(start.pass.url, { method: 'PUT', headers: { ...start.pass.headers, ...(start.pass.token ? { authorization: `Bearer ${start.pass.token}` } : {}), 'x-content-type': start.contentType || type }, body: blob });
    } catch {
      throw new ApiError('The upload was interrupted. Check your connection and try again.', 0);
    }
    const stored = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(stored?.error?.message || `Upload failed (${res.status})`, res.status, stored);
    return request('POST', finishPath, { ticket: start.ticket, url: stored.url || '' });
  },
};

/**
 * POST and consume a Server-Sent Events response.
 * `onEvent(type, data)` is called for every event.
 */
export async function stream(path, body, { onEvent, signal }) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let type = 'message';
        const data = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        let payload;
        try {
          payload = JSON.parse(data.join('\n'));
        } catch {
          continue; // malformed event
        }
        // Outside the try: an error thrown by the handler (an `error` event, for one) ends the stream.
        onEvent(type, payload);
      }
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
}
