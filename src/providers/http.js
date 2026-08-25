// Shared helpers for live-data providers: a timeout-guarded JSON fetch (uses
// Node 24's global fetch — no dependency) and deterministic fallback pricing so
// that when no API key is configured the product is still fully usable and the
// same query always yields the same clearly-labeled estimate.

export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { /* non-JSON error body */ } }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${safeHost(url)}`);
      err.status = res.status;
      err.body = json || text.slice(0, 500);
      throw err;
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

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'upstream'; }
}

// FNV-1a — stable across runs and platforms; used only for fallback pricing.
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
