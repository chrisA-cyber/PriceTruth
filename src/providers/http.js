// Shared helpers for live-data providers: a timeout-guarded JSON fetch (uses
// Node 24's global fetch — no dependency) plus deterministic helpers retained
// only for explicitly labeled illustrative fixtures. Shopper search fails closed.

export async function httpJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 6000,
  maxResponseBytes = Number(process.env.PROVIDER_RESPONSE_LIMIT_BYTES) || 1024 * 1024,
  redirect = 'follow',
  fetchImpl = globalThis.fetch,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, headers, body, redirect, signal: ctrl.signal });
    if (redirect === 'manual' && res.status >= 300 && res.status < 400) {
      try { await res.body?.cancel?.(); } catch { /* best-effort connection cleanup */ }
      const error = new Error(`redirect rejected from ${safeHost(url)}`);
      error.status = 502;
      error.code = 'UPSTREAM_REDIRECT_REJECTED';
      throw error;
    }
    const text = await limitedResponseText(res, maxResponseBytes, url);
    let json = null;
    if (text) {
      try { json = JSON.parse(text); }
      catch {
        if (res.ok) {
          const error = new Error(`invalid JSON response from ${safeHost(url)}`);
          error.status = 502;
          error.code = 'UPSTREAM_INVALID_JSON';
          throw error;
        }
        // Error bodies can be HTML/text; the status remains authoritative.
      }
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${safeHost(url)}`);
      err.status = res.status;
      err.body = json || text.slice(0, 500);
      throw err;
    }
    if (json === null) {
      const error = new Error(`empty JSON response from ${safeHost(url)}`);
      error.status = 502;
      error.code = 'UPSTREAM_INVALID_JSON';
      throw error;
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`timeout after ${timeoutMs}ms from ${safeHost(url)}`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function limitedResponseText(response, maxResponseBytes, url) {
  const limit = Math.min(8 * 1024 * 1024, Math.max(1024, Number(maxResponseBytes) || 1024 * 1024));
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > limit) {
      await response.body?.cancel?.().catch(() => {});
      throw upstreamPayloadError(url, limit);
    }
  }

  // WHATWG fetch responses expose a byte ReadableStream. Consume it manually
  // so a missing/lying Content-Length cannot allocate an unbounded buffer.
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          throw upstreamPayloadError(url, limit);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }

  // Compatibility for small test/custom fetch implementations without a
  // web-stream body. The post-read check still enforces the same contract.
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw upstreamPayloadError(url, limit);
  return text;
}

function upstreamPayloadError(url, limit) {
  const error = new Error(`response exceeds ${limit} bytes from ${safeHost(url)}`);
  error.status = 502;
  error.code = 'UPSTREAM_PAYLOAD_TOO_LARGE';
  return error;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'upstream'; }
}

// FNV-1a — stable across runs and platforms; used only for illustrative fixtures.
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Deterministic integer-cents value inside [loCents, hiCents] from a seed.
export function bandCents(seed, loCents, hiCents) {
  const span = Math.max(1, hiCents - loCents);
  return loCents + (seed % span);
}

export function titleize(q) {
  return String(q)
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 80);
}

// Slug usable as a product id: lowercase, [a-z0-9-], starts alnum, <=64 chars.
export function toSlug(...parts) {
  const s = parts.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9]/.test(s) ? s : `x${s}`.slice(0, 64);
}
