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
      return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / this.refillPerSec) };
    }
    b.tokens -= 1;
    return { ok: true };
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(req, { limitBytes = 32 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, `body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'body must be a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'request stream error')));
  });
}

// Reads the request body as raw text (no JSON parsing). Needed for webhook
// signature verification, which must run over the exact bytes received.
function readRawBody(req, { limitBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, `body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'request stream error')));
  });
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;

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
};

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export { applySecurityHeaders, RateLimiter, HttpError, readJsonBody, readRawBody, validate, escapeHtml, CSP };
