'use strict';

/* PriceTruth owner dashboard — CSP-strict (no inline script), DOM built via
   createElement/textContent. Auth is the server's ADMIN_TOKEN, entered here and
   held only in sessionStorage for this tab. */

(function () {
  const body = document.getElementById('admin-body');
  const TOKEN_KEY = 'pt-admin-token';

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) { for (const c of kid) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); continue; }
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function fmtUSD(cents) {
    if (!Number.isFinite(cents)) return '$—';
    const neg = cents < 0;
    const d = String(Math.abs(Math.round(cents))).padStart(3, '0');
    let whole = d.slice(0, -2); const frac = d.slice(-2);
    let g = ''; for (let i = 0; i < whole.length; i++) { if (i > 0 && (whole.length - i) % 3 === 0) g += ','; g += whole[i]; }
    return `${neg ? '-' : ''}$${g}.${frac}`;
  }
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ } }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }

  function loginForm(message) {
    const input = el('input', { type: 'password', id: 'admin-token', placeholder: 'ADMIN_TOKEN', 'aria-label': 'Admin token', autocomplete: 'off' });
    const status = el('div', { 'aria-live': 'polite' });
    const form = el('form', {
      onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; setToken(t); load(); },
    },
      el('div', { class: 'field' }, el('label', { for: 'admin-token' }, 'Admin token'), input),
      el('button', { class: 'btn', type: 'submit' }, 'Unlock dashboard'), status);
    if (message) status.append(el('p', { class: 'form-error' }, message));
    return el('div', { class: 'card', style: 'max-width:30rem' }, el('h2', null, 'Sign in'), form);
  }

  function statCard(label, value, sub) {
    return el('div', { class: 'card', style: 'padding:1.1rem 1.25rem' },
      el('div', { style: 'font-size:0.8rem;letter-spacing:0.02em;text-transform:uppercase;color:var(--text-faint)' }, label),
      el('div', { style: 'font-size:1.9rem;font-weight:800;margin-top:0.2rem' }, value),
      sub ? el('div', { style: 'font-size:0.85rem;color:var(--text-soft);margin-top:0.15rem' }, sub) : null);
  }

  function render(data) {
    clear(body);
    const b = data.billing || {};
    const u = data.usage || {};

    const modeChip = el('span', { class: b.mode === 'live' ? 'chip chip-live' : 'chip chip-demo' },
      b.mode === 'live' ? 'Stripe live' : 'Stripe simulated');
    body.append(el('div', { style: 'display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem' },
      modeChip,
      el('span', { style: 'color:var(--text-faint);font-size:0.85rem' }, `generated ${new Date(data.generatedAt).toLocaleString()}`),
      el('button', { class: 'btn btn-secondary', type: 'button', style: 'margin-left:auto', onclick: load }, 'Refresh'),
      el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { clearToken(); load(); } }, 'Sign out')));

    body.append(el('div', { class: 'stat-grid', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:1rem;margin-bottom:1.5rem' },
      statCard('Gross revenue', fmtUSD(b.gross_cents || 0), `${b.paid_events || 0} paid events`),
      statCard('Last 30 days', fmtUSD(b.last_30d_cents || 0)),
      statCard('Last 7 days', fmtUSD(b.last_7d_cents || 0)),
      statCard('API calls today', String(u.api_calls_today || 0), `${u.api_calls_7d || 0} in 7 days`),
      statCard('Tracked products', String(u.products || 0), `${u.price_points || 0} price points`),
      statCard('Active alerts', String(u.alerts || 0))));

    // active plans
    const plans = b.active_plans || [];
    body.append(el('section', { style: 'margin-bottom:1.5rem' },
      el('h2', null, 'Active plans'),
      plans.length
        ? el('ul', null, plans.map((p) => el('li', null, `${p.plan}: ${p.n}`)))
        : el('p', { style: 'color:var(--text-soft)' }, 'No paid accounts yet.')));

    // API keys by tier
    const keys = u.keys_by_tier || [];
    body.append(el('section', { style: 'margin-bottom:1.5rem' },
      el('h2', null, 'API keys'),
      keys.length
        ? el('ul', null, keys.map((k) => el('li', null, `${k.tier}: ${k.n} active`)))
        : el('p', { style: 'color:var(--text-soft)' }, 'No API keys issued yet.')));

    // data sources
    const prov = data.providers || {};
    body.append(el('section', { style: 'margin-bottom:1.5rem' },
      el('h2', null, 'Live data sources'),
      el('ul', null, Object.entries(prov).map(([v, s]) =>
        el('li', null, `${v}: `, el('span', { class: s.live ? 'chip chip-live' : 'chip chip-estimate' }, s.live ? 'live' : 'estimate'))))));

    // recent revenue
    const recent = b.recent || [];
    body.append(el('section', null,
      el('h2', null, 'Recent billing events'),
      recent.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'breakdown' },
            el('thead', null, el('tr', null,
              el('th', { scope: 'col' }, 'When'), el('th', { scope: 'col' }, 'Type'),
              el('th', { scope: 'col' }, 'Plan'), el('th', { scope: 'col' }, 'Mode'),
              el('th', { scope: 'col', class: 'amount' }, 'Amount'))),
            el('tbody', null, recent.map((r) => el('tr', null,
              el('td', null, new Date(r.ts).toLocaleString()),
              el('td', null, r.type),
              el('td', null, r.plan || '—'),
              el('td', null, r.livemode ? 'live' : 'test'),
              el('td', { class: 'amount' }, fmtUSD(r.amount_cents)))))))
        : el('p', { style: 'color:var(--text-soft)' }, 'No billing events recorded yet.')));
  }

  function load() {
    const token = getToken();
    if (!token) { clear(body); body.append(loginForm()); return; }
    clear(body);
    body.append(el('p', { role: 'status' }, 'Loading metrics…'));
    fetch('/api/admin/metrics', { headers: { 'X-Admin-Token': token } })
      .then(async (res) => {
        if (res.status === 403) { clearToken(); clear(body); body.append(loginForm('That token was rejected. Check ADMIN_TOKEN on the server.')); return; }
        if (!res.ok) { clear(body); body.append(el('div', { class: 'card state-error' }, el('p', null, `Request failed (HTTP ${res.status}).`), el('button', { class: 'btn btn-secondary', type: 'button', onclick: load }, 'Retry'))); return; }
        render(await res.json());
      })
      .catch(() => { clear(body); body.append(el('div', { class: 'card state-error' }, el('p', null, 'Could not reach the server.'), el('button', { class: 'btn btn-secondary', type: 'button', onclick: load }, 'Retry'))); });
  }

  load();
})();
