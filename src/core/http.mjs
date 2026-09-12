// Meridian ERP :: core/http
// Minimal router, request/response helpers and security headers.
// Built on node:http only -- no framework, no middleware chain to audit.
import { ulid, isValidDate } from './util.mjs';

export class HttpError extends Error {
  constructor(status, message, code = null, details = null) {
    super(message); this.name = 'HttpError'; this.status = status;
    this.code = code || CODE_FOR[status] || 'ERROR'; this.details = details;
  }
}
const CODE_FOR = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED', 500: 'INTERNAL' };

export const badRequest = (m, d) => new HttpError(400, m, 'BAD_REQUEST', d);

/**
 * A body field that is meant to be a list of rows. Absent means none; a
 * string or a number where an array belongs is a bad request, not a 500 --
 * `(body.lines || []).map(...)` accepts "oops" happily and then throws deep
 * inside whichever module was handed it.
 */
export function rowList(value, label = 'lines') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `"${label}" must be a list`, 'BAD_REQUEST');
  return value;
}
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
export const forbidden = (m = 'Not permitted') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m, d) => new HttpError(409, m, 'CONFLICT', d);
export const unprocessable = (m, d) => new HttpError(422, m, 'UNPROCESSABLE', d);

/**
 * Field-level validation failure, surfaced next to the input in the UI.
 *
 * When exactly one field failed, its own message becomes the headline. A
 * caller that only shows `error.message` then still tells the user what is
 * actually wrong instead of "please correct the highlighted fields".
 */
export class ValidationError extends HttpError {
  constructor(fields, message = null) {
    const reasons = [...new Set(Object.values(fields || {}).filter(Boolean))];
    const headline = message
      || (reasons.length === 1 ? reasons[0]
        : `Please correct the ${reasons.length} highlighted fields`);
    super(422, headline, 'VALIDATION_FAILED', { fields });
    this.fields = fields;
  }
}

// ---------------------------------------------------------------- router
/**
 * A date on its way into SQL.
 *
 * Dates arrive from query strings and request bodies, so one can be an array,
 * an object or the word "yesterday". SQLite cannot bind most of those and
 * throws a driver-level TypeError, which reaches the client as a 500 for what
 * is only ever a badly typed filter. Checked here so every caller gets the
 * same sentence instead.
 */
export function requireDate(value, field = 'date') {
  if (!isValidDate(value)) throw new ValidationError({ [field]: 'Enter a valid date (YYYY-MM-DD)' });
  return value;
}

/** The same, for a filter that is allowed to be absent. */
export function optionalDate(value, field = 'date') {
  if (value === null || value === undefined || value === '') return null;
  return requireDate(value, field);
}

export class Router {
  constructor() { this.routes = []; this.sorted = null; }

  /**
   * Compile "/api/v1/records/:type/:id" into a matcher.
   * Built segment by segment: a path separator is structure, everything else
   * is escaped literal text. (Escaping the whole pattern first and then
   * hunting for ":name" is how you end up with routes that silently never
   * match.)
   */
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    // Per-segment specificity, so `/bank/statements/import` beats
    // `/bank/:id/import` no matter which was registered first: 2 = literal,
    // 1 = parameter, 0 = wildcard.
    const rank = [];
    const source = pattern.replace(/\/+$/, '').split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); rank.push(1); return '([^/]+)'; }
      if (seg === '*') { rank.push(0); return '(.*)'; }
      rank.push(2);
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    const rx = new RegExp('^' + source + '/?$');
    const clash = this.routes.find((r) => r.method === method && r.pattern === pattern);
    if (clash) {
      // Two handlers on one address means one of them is dead code that nobody
      // will notice until a feature silently does the wrong thing.
      throw new Error(`Duplicate route: ${method} ${pattern} is already registered`);
    }
    this.routes.push({ method, pattern, rx, keys, rank, handler, opts });
    this.sorted = null;
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** Most specific first, so registration order cannot shadow a literal path. */
  ordered() {
    if (this.sorted) return this.sorted;
    this.sorted = [...this.routes].sort((a, b) => {
      const n = Math.max(a.rank.length, b.rank.length);
      for (let i = 0; i < n; i++) {
        const x = a.rank[i] ?? -1; const y = b.rank[i] ?? -1;
        if (x !== y) return y - x;
      }
      return 0;
    });
    return this.sorted;
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.ordered()) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// -------------------------------------------------------------- requests
export async function readBody(req, { limit = 8 * 1024 * 1024 } = {}) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks);
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw.toString('utf8')); }
    catch (e) { throw badRequest(`Malformed JSON: ${e.message}`); }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  if (ct.includes('text/csv') || ct.includes('text/plain')) return raw.toString('utf8');
  // SOAP 1.1 sends text/xml, SOAP 1.2 application/soap+xml; both arrive as
  // the raw document for the service to parse.
  if (ct.includes('xml')) return raw.toString('utf8');
  return raw;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const p = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) p.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) p.push(`Expires=${new Date(opts.expires).toUTCString()}`);
  p.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) p.push('HttpOnly');
  if (opts.secure) p.push('Secure');
  p.push(`SameSite=${opts.sameSite || 'Strict'}`);
  return p.join('; ');
}

/** Query string -> object, with [] repeated keys collapsed into arrays. */
export function parseQuery(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    if (k in out) { out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v]; }
    else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------- responses
export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const h = { ...securityHeaders(), ...headers };
  if (body === null || body === undefined) { res.writeHead(status, h); res.end(); return; }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(buf);
}

export const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

export function sendError(res, err, { exposeStack = false, requestId = '' } = {}) {
  const status = err.status || 500;
  const payload = {
    error: {
      code: err.code || 'INTERNAL',
      message: status === 500 && !exposeStack ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(err.fields ? { fields: err.fields } : {}),
      requestId,
    },
  };
  if (exposeStack && status === 500) payload.error.stack = err.stack;
  return sendJson(res, status, payload);
}

/**
 * Security headers. The CSP is strict: no inline script, no remote origins.
 * Everything the UI needs is served from this origin, which is what lets the
 * app run offline and keeps a tenant's custom field labels from ever
 * becoming an XSS vector.
 */
export function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
  };
}

// ----------------------------------------------------------- rate limiter
/** Fixed-window counter. Enough to blunt credential stuffing on a local app. */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 300 } = {}) {
    this.windowMs = windowMs; this.max = max; this.hits = new Map();
  }
  check(key) {
    const now = Date.now();
    const bucket = Math.floor(now / this.windowMs);
    const k = `${key}:${bucket}`;
    const n = (this.hits.get(k) || 0) + 1;
    this.hits.set(k, n);
    if (this.hits.size > 20000) {                    // opportunistic sweep
      for (const kk of this.hits.keys()) if (!kk.endsWith(`:${bucket}`)) this.hits.delete(kk);
    }
    return { ok: n <= this.max, remaining: Math.max(0, this.max - n), resetMs: (bucket + 1) * this.windowMs - now };
  }
}

export const newRequestId = () => ulid().slice(-12);

/** Client IP, trusting a proxy header only when explicitly configured. */
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}
