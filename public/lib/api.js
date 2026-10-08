// API client. One place that knows the envelope ({data, meta} / {error}),
// turns errors into ApiError, and sends updated_at back as If-Match so the
// server can refuse a write that would overwrite someone else's change.

export class ApiError extends Error {
  constructor(status, body) {
    const e = (body && body.error) || {};
    super(e.message || `HTTP ${status}`);
    this.status = status;
    this.code = e.code || 'http_' + status;
    this.details = e.details;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

async function request(method, path, { params, body, version, raw, form } = {}) {
  const headers = {};
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (version) headers['if-match'] = version;
  let res;
  try {
    res = await fetch('/api' + path + qs(params), { method, headers, body: payload, credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError(0, { error: { code: 'offline', message: 'Network error' } });
  }
  if (raw) { if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null)); return res; }
  const json = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/')) { onUnauthorized(); throw new ApiError(401, json); }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const api = {
  // get() returns data only; list() returns {data, meta} for paginated lists.
  get: async (path, params) => (await request('GET', path, { params })).data,
  list: (path, params) => request('GET', path, { params }),
  post: async (path, body) => (await request('POST', path, { body: body ?? {} })).data,
  put: async (path, body) => (await request('PUT', path, { body: body ?? {} })).data,
  patch: async (path, body, version) => (await request('PATCH', path, { body, version })).data,
  del: async (path) => (await request('DELETE', path)).data,
  upload: async (path, form) => (await request('POST', path, { form })).data,
  raw: (path, params) => request('GET', path, { params, raw: true }),
};

// Fetches every page of a list endpoint (for small sets like project members).
export async function listAll(path, params = {}, max = 2000) {
  const out = [];
  let offset = 0;
  while (out.length < max) {
    const r = await api.list(path, { ...params, limit: 200, offset });
    out.push(...r.data);
    if (r.meta?.next_offset == null) break;
    offset = r.meta.next_offset;
  }
  return out;
}
