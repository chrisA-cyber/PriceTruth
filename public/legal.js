'use strict';

(function () {
  function supportHref(contact) {
    const value = String(contact || '').trim();
    if (/^https:\/\//i.test(value) || /^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
    if (/^[^\s@]+@[^\s@]+$/.test(value)) return `mailto:${value}`;
    return null;
  }

  function append(node, ...parts) {
    node.replaceChildren();
    for (const part of parts) {
      node.append(part && part.nodeType ? part : document.createTextNode(String(part)));
    }
  }

  function supportLink(legal) {
    const href = supportHref(legal.supportContact);
    if (!href) return null;
    const link = document.createElement('a');
    link.href = href;
    link.textContent = /^mailto:/i.test(href) ? legal.supportContact.replace(/^mailto:/i, '') : 'private support';
    if (/^https:/i.test(href)) link.rel = 'noopener';
    return link;
  }

  function approvedCommercial(meta) {
    const legal = meta && meta.legal;
    return Boolean(meta && meta.billing && meta.billing.mode === 'live'
      && legal && legal.configured === true && legal.approved === true
      && [legal.operatorName, legal.jurisdiction, legal.supportContact, legal.effectiveDate, legal.termsVersion]
        .every((value) => typeof value === 'string' && value.trim())
      && supportHref(legal.supportContact));
  }

  function applyCanonicalMeta(meta) {
    let base;
    try { base = new URL(meta && meta.publicBaseUrl ? meta.publicBaseUrl : ''); }
    catch (err) { return; }
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
      || base.origin !== location.origin || (base.pathname !== '/' && base.pathname !== '')
      || base.search || base.hash) return;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = new URL('/legal.html', base).href;
  }

  fetch('/api/meta', { headers: { Accept: 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error('metadata unavailable');
      return response.json();
    })
    .then((meta) => {
      applyCanonicalMeta(meta);
      if (!approvedCommercial(meta)) return;
      const legal = meta.legal;
      const identity = document.getElementById('legal-identity');
      const effective = document.getElementById('legal-effective');
      const support = document.getElementById('legal-support');
      const paid = document.getElementById('legal-paid-plans');
      const law = document.getElementById('legal-law');
      const footer = document.getElementById('legal-footer-identity');

      const strong = document.createElement('strong');
      strong.textContent = `Commercial operator: ${legal.operatorName}.`;
      append(identity, strong, ` Jurisdiction: ${legal.jurisdiction}. Terms version ${legal.termsVersion}; effective ${legal.effectiveDate}. `,
        supportLink(legal), '.');
      identity.classList.remove('warning');
      effective.textContent = `Terms version ${legal.termsVersion} · effective and last updated ${legal.effectiveDate}`;
      append(support,
        'Use the self-service dashboard for account data. For a private support request or a privacy, billing, or security matter, use ',
        supportLink(legal), `. Do not post personal information, credentials, or vulnerability details in a public issue.`);
      append(paid,
        `Paid plans on this deployment are offered by ${legal.operatorName}. Checkout shows the price, billing period, included quota, renewal terms, taxes, and cancellation path before payment. Subscriptions renew until canceled through the billing portal. Mandatory refund rights in ${legal.jurisdiction} remain unaffected; contact `,
        supportLink(legal), ' for billing review.');
      law.textContent = `These terms are issued by ${legal.operatorName} under ${legal.jurisdiction}. Mandatory consumer protections and any required dispute rights remain unaffected. Material changes will receive a new effective date and any notice required by law.`;
      append(footer, `${legal.operatorName} · ${legal.jurisdiction} · Terms ${legal.termsVersion} · Effective ${legal.effectiveDate} · `, supportLink(legal));
    })
    .catch(() => { /* neutral, noncommercial server-rendered language remains */ });
})();
