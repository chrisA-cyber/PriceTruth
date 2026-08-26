import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legalNames = ['privacy.md', 'terms.md', 'affiliate-disclosure.md', 'compliance.md'];
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

describe('legal publication gate', () => {
  const legalDocs = legalNames.map((name) => ({ name, text: read('docs', 'legal', name) }));

  it('keeps operator-input workbooks unmistakably internal and blocked', () => {
    for (const { name, text } of legalDocs) {
      assert.match(text, /INTERNAL PRELAUNCH/i, `${name} needs the internal marker`);
      assert.match(text, /NOT (?:A |TERMS OF SERVICE|LEGAL ADVICE|A PUBLIC )/i, `${name} needs a non-public warning`);
      assert.match(text, /Blocked/i, `${name} needs an explicit blocked status`);
      assert.match(text, /fail-closed/i, `${name} needs the fail-closed gate`);
    }
  });

  it('contains no publishable-looking placeholder facts', () => {
    const combined = legalDocs.map(({ text }) => text).join('\n');
    assert.doesNotMatch(combined, /\[(?:COMPANY ENTITY|CONTACT EMAIL|GOVERNING LAW JURISDICTION|VENUE|OPERATOR|ADDRESS|DATE)\]/i);
    assert.doesNotMatch(combined, /pricetruth\.example|security@/i);
    assert.doesNotMatch(combined, /\bprototype\b|\bplaceholder\b/i);
  });

  it('does not publish a fake security reporting route or unsupported promises', () => {
    const security = read('docs', 'SECURITY.md');
    const disclosureGate = security.slice(security.indexOf('## 5. Responsible-disclosure publication gate'));
    assert.match(disclosureGate, /Internal prelaunch guidance/i);
    assert.match(disclosureGate, /reporting contact has not been supplied/i);
    assert.doesNotMatch(disclosureGate, /pricetruth\.example|security@|90 days|5 business days/i);
  });
});
