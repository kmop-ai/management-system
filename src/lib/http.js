// HTTP envelope, errors and list parameters.
//
// Every response is JSON with one of two shapes:
//   { data, meta? }                         success
//   { error: { code, message, details? } }  failure
// Codes are stable strings the front end switches on; messages are English
// for logs and are translated client-side from the code where it matters.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (message, details) => new HttpError(409, 'conflict', message, details);
export const invalid = (fields) => new HttpError(422, 'validation_failed', 'Some fields are not valid', { fields });

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

export function ok(data, meta, headers) {
  return json(meta ? { data, meta } : { data }, 200, headers);
}

export function created(data, headers) {
  return json({ data }, 201, headers);
}

export function errorResponse(err, requestId) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status,
      { 'x-request-id': requestId });
  }
  console.error(`[${requestId}]`, err && err.stack || err);
  return json({ error: { code: 'internal', message: 'Something went wrong. The error has been logged.', request_id: requestId } }, 500,
    { 'x-request-id': requestId });
}

export async function readJson(req) {
  const type = req.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw badRequest('Expected a JSON body');
  try {
    const body = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw badRequest('Body is not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Validation: small, explicit, no schema library. Each helper returns the
// cleaned value or records an error under the field name.
// ---------------------------------------------------------------------------

export class Validator {
  constructor(body) { this.body = body || {}; this.errors = {}; this.out = {}; }
  has(k) { return Object.prototype.hasOwnProperty.call(this.body, k); }
  fail(k, msg) { this.errors[k] = msg; }

  string(k, { required = false, max = 500, min = 0, nullable = true, trim = true } = {}) {
    if (!this.has(k)) { if (required) this.fail(k, 'required'); return this; }
    let v = this.body[k];
    if (v === null || v === '') {
      if (required || !nullable) this.fail(k, 'required'); else this.out[k] = null;
      return this;
    }
    if (typeof v !== 'string') { this.fail(k, 'must be text'); return this; }
    if (trim) v = v.trim();
    if (v.length < min) this.fail(k, `must be at least ${min} characters`);
    else if (v.length > max) this.fail(k, `must be at most ${max} characters`);
    else if (required && !v) this.fail(k, 'required');
    else this.out[k] = v;
    return this;
  }
  text(k, opts = {}) { return this.string(k, { max: 50000, trim: false, ...opts }); }
  int(k, { required = false, min = -Infinity, max = Infinity, nullable = true } = {}) {
    if (!this.has(k)) { if (required) this.fail(k, 'required'); return this; }
    const v = this.body[k];
    if (v === null || v === '') { if (required || !nullable) this.fail(k, 'required'); else this.out[k] = null; return this; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) this.fail(k, 'must be a whole number in range');
    else this.out[k] = n;
    return this;
  }
  number(k, { required = false, min = -Infinity, max = Infinity, nullable = true } = {}) {
    if (!this.has(k)) { if (required) this.fail(k, 'required'); return this; }
    const v = this.body[k];
    if (v === null || v === '') { if (required || !nullable) this.fail(k, 'required'); else this.out[k] = null; return this; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) this.fail(k, 'must be a number in range');
    else this.out[k] = n;
    return this;
  }
  bool(k) {
    if (!this.has(k)) return this;
    const v = this.body[k];
    this.out[k] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    return this;
  }
  date(k, { required = false } = {}) {
    if (!this.has(k)) { if (required) this.fail(k, 'required'); return this; }
    const v = this.body[k];
    if (v === null || v === '') { if (required) this.fail(k, 'required'); else this.out[k] = null; return this; }
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) this.fail(k, 'must be a date (YYYY-MM-DD)');
    else this.out[k] = v;
    return this;
  }
  oneOf(k, values, { required = false } = {}) {
    if (!this.has(k)) { if (required) this.fail(k, 'required'); return this; }
    const v = this.body[k];
    if (!values.includes(v)) this.fail(k, `must be one of: ${values.join(', ')}`);
    else this.out[k] = v;
    return this;
  }
  email(k, { required = false } = {}) {
    this.string(k, { required, max: 254 });
    if (this.out[k] != null) {
      const v = this.out[k].toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) this.fail(k, 'must be an email address');
      else this.out[k] = v;
    }
    return this;
  }
  ids(k) {
    if (!this.has(k)) return this;
    const v = this.body[k];
    if (!Array.isArray(v) || !v.every(x => Number.isInteger(Number(x)))) this.fail(k, 'must be a list of ids');
    else this.out[k] = [...new Set(v.map(Number))];
    return this;
  }
  done() {
    if (Object.keys(this.errors).length) throw invalid(this.errors);
    return this.out;
  }
}

// ---------------------------------------------------------------------------
// List parameters. Every list endpoint accepts:
//   ?limit=50&offset=0          pagination (limit capped at 200)
//   ?sort=due_date,-priority    comma-separated, '-' for descending
//   ?<filter>=value             endpoint-specific filters
// and returns meta { total, limit, offset, next_offset }.
// ---------------------------------------------------------------------------

export function pageParams(url, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || defaultLimit, 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  return { limit, offset };
}

// sortable maps public sort keys to SQL expressions; unknown keys are an error
// rather than silently ignored, so a typo in a saved view shows up.
export function sortClause(url, sortable, fallback) {
  const raw = url.searchParams.get('sort');
  const parts = (raw ? raw.split(',') : fallback.split(',')).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const desc = p.startsWith('-');
    const key = desc ? p.slice(1) : p;
    const expr = sortable[key];
    if (!expr) throw badRequest(`Cannot sort by "${key}"`, { sortable: Object.keys(sortable) });
    // NULLs last in both directions: undated tasks belong at the bottom.
    out.push(`(${expr}) IS NULL, ${expr} ${desc ? 'DESC' : 'ASC'}`);
  }
  return out.length ? out.join(', ') : '1';
}

export function listMeta(total, { limit, offset }, returned) {
  const next = offset + returned < total ? offset + returned : null;
  return { total, limit, offset, next_offset: next };
}

export function param(url, k) {
  const v = url.searchParams.get(k);
  return v === null || v === '' ? null : v;
}

export function intParam(url, k) {
  const v = param(url, k);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${k} must be a whole number`);
  return n;
}

export function idList(url, k) {
  const v = param(url, k);
  if (v === null) return null;
  const ids = v.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (!ids.every(Number.isInteger)) throw badRequest(`${k} must be a comma-separated list of ids`);
  return ids;
}
