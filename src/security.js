import crypto from 'node:crypto';

// Security middleware for the zero-dependency HTTP server: strict headers,
// per-client token-bucket rate limiting, safe JSON body parsing, validators.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // inline style attributes only; no external styles
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function applySecurityHeaders(res, { isApi = false } = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (isApi) res.setHeader('Cache-Control', 'no-store');
}

// Token bucket per client key. Buckets are pruned so the map cannot grow
// unbounded under an address-rotation flood.
class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 1, maxBuckets = 10_000 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxBuckets = maxBuckets;
    this.buckets = new Map();
  }

  check(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxBuckets) this.prune(now);
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
    b.last = now;
    if (b.tokens < 1) {
      const retryAfterSec = Math.ceil((1 - b.tokens) / this.refillPerSec);
      return { ok: false, retryAfterSec, limit: this.capacity, remaining: 0, resetSec: retryAfterSec };
    }
    b.tokens -= 1;
    return {
      ok: true,
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(b.tokens)),
      resetSec: Math.max(1, Math.ceil((this.capacity - b.tokens) / this.refillPerSec)),
    };
  }

  prune(now = Date.now()) {
    for (const [key, b] of this.buckets) {
      if (now - b.last > 10 * 60 * 1000) this.buckets.delete(key);
    }
    // Still full of active buckets: drop oldest entries (insertion order).
    if (this.buckets.size >= this.maxBuckets) {
      const drop = Math.ceil(this.maxBuckets / 10);
      let i = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (++i >= drop) break;
      }
    }
  }
}

class HttpError extends Error {
  constructor(status, message, { code = null, details = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readJsonBody(req, {
  limitBytes = 32 * 1024,
  timeoutMs = Number(process.env.JSON_BODY_TIMEOUT_MS) || 10_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const boundedTimeout = Math.min(60_000, Math.max(1, Number(timeoutMs) || 10_000));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const contentLength = req.headers?.['content-length'];
    if (contentLength !== undefined) {
      const bytes = Number(contentLength);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        reject(new HttpError(400, 'invalid Content-Length'));
        return;
      }
      if (bytes > limitBytes) {
        req.resume?.();
        reject(new HttpError(413, `body exceeds ${limitBytes} bytes`));
        return;
      }
    }
    const timer = setTimeout(() => {
      req.resume?.();
      finish(new HttpError(408, 'request body timed out'));
    }, boundedTimeout);
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        req.resume?.();
        finish(new HttpError(413, `body exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (size === 0) return finish(null, {});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish(new HttpError(400, 'body must be a JSON object'));
        }
        finish(null, parsed);
      } catch {
        finish(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('aborted', () => finish(new HttpError(400, 'request stream aborted')));
    req.on('error', () => finish(new HttpError(400, 'request stream error')));
  });
}

// Reads the request body as raw text (no JSON parsing). Needed for webhook
// signature verification, which must run over the exact bytes received.
function readRawBody(req, { limitBytes = 1024 * 1024, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    const timer = setTimeout(() => {
      if (rejected) return;
      rejected = true;
      req.resume();
      reject(new HttpError(408, 'request body timed out'));
    }, Math.min(30_000, Math.max(1_000, timeoutMs)));
    const clear = () => clearTimeout(timer);
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limitBytes) {
        rejected = true;
        clear();
        reject(new HttpError(413, `body exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { clear(); if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { clear(); if (!rejected) reject(new HttpError(400, 'request stream error')); });
  });
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;

// Production public origins and published contact destinations must not be
// loopback, literals, internal-only names, or RFC/example placeholders. DNS is
// deliberately not resolved here; deployment verification owns reachability.
function isPublicHostname(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || !host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return false;
  if (['localhost', 'test', 'example', 'invalid', 'local', 'internal', 'lan'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  if (['example.com', 'example.net', 'example.org'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host);
}

const validate = {
  cents(v, name) {
    if (!Number.isSafeInteger(v) || v < 0 || v > 1_000_000_000) throw new HttpError(400, `${name} must be integer cents (0..1e9)`);
    return v;
  },
  int(v, name, lo, hi) {
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new HttpError(400, `${name} must be an integer in [${lo}, ${hi}]`);
    return v;
  },
  string(v, name, max = 200) {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(400, `${name} must be a 1..${max} char string`);
    return v;
  },
  enum(v, name, allowed) {
    if (!allowed.includes(v)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
    return v;
  },
  email(v, name = 'email') {
    if (typeof v !== 'string' || v.length > 320 || !EMAIL_RE.test(v)) throw new HttpError(400, `${name} must be a valid email address`);
    return v.toLowerCase();
  },
  id(v, name = 'id') {
    if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) throw new HttpError(400, `${name} must be a lowercase slug`);
    return v;
  },
  bool(v, name) {
    if (typeof v !== 'boolean') throw new HttpError(400, `${name} must be a boolean`);
    return v;
  },
  timezone(v, name = 'timezone') {
    if (typeof v !== 'string' || v.length < 1 || v.length > 64) throw new HttpError(400, `${name} must be a valid IANA timezone`);
    try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(); } catch { throw new HttpError(400, `${name} must be a valid IANA timezone`); }
    return v;
  },
  token(v, name = 'token') {
    if (typeof v !== 'string' || v.length < 32 || v.length > 256 || !/^[A-Za-z0-9_-]+$/.test(v)) {
      throw new HttpError(400, `${name} is invalid`);
    }
    return v;
  },
};

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* malformed cookie */ }
  }
  return result;
}

function serializeCookie(name, value, { maxAge, expires, secure = false, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError('invalid cookie name');
  const parts = [`${name}=${encodeURIComponent(String(value))}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (Number.isInteger(maxAge)) parts.push(`Max-Age=${maxAge}`);
  if (expires instanceof Date) parts.push(`Expires=${expires.toUTCString()}`);
  return parts.join('; ');
}

function requestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,100}$/.test(value)
    ? value
    : crypto.randomUUID();
}

function assertSameOrigin(req, expectedOrigin) {
  const origin = req.headers.origin;
  // Non-browser clients commonly omit Origin; cookie-authenticated mutations
  // also require a high-entropy CSRF token. If supplied, Origin must match.
  if (origin && origin !== expectedOrigin) throw new HttpError(403, 'request origin is not allowed');
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw new HttpError(403, 'cross-site request is not allowed');
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export { applySecurityHeaders, RateLimiter, HttpError, readJsonBody, readRawBody, validate, escapeHtml, parseCookies, serializeCookie, requestId, assertSameOrigin, isPublicHostname, CSP };
