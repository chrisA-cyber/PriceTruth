import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { prepareExtensionManifest } from '../src/extzip.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const failures = [];
const requireFile = (file) => { if (!fs.existsSync(path.join(EXT, file))) failures.push(`missing ${file}`); };

if (manifest.manifest_version !== 3) failures.push('manifest_version must be 3');
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version || '')) failures.push('manifest version is not Chrome-compatible');
const allowedPermissions = new Set(['storage']);
for (const permission of manifest.permissions || []) if (!allowedPermissions.has(permission)) failures.push(`unexpected permission: ${permission}`);

for (const icon of Object.values(manifest.icons || {})) requireFile(icon);
requireFile(manifest.action?.default_popup);
requireFile(manifest.options_ui?.page);
for (const content of manifest.content_scripts || []) {
  for (const file of [...(content.js || []), ...(content.css || [])]) requireFile(file);
}
const releaseManifest = prepareExtensionManifest(manifest, 'https://app.pricetruth.invalid');
const releaseMatches = (releaseManifest.content_scripts || []).flatMap((item) => item.matches || []);
if (releaseMatches.some((pattern) => /example\.com|localhost|127\.0\.0\.1/i.test(pattern))) failures.push('release manifest retains a fixture host');
if (releaseMatches.some((pattern) => pattern.startsWith('*://'))) failures.push('release manifest permits non-HTTPS seller access');

const jsFiles = ['config.js', 'adapters.js', 'feemodel.js', 'content.js', 'popup.js', 'options.js'];
const source = jsFiles.map((file) => fs.readFileSync(path.join(EXT, file), 'utf8')).join('\n');
for (const [name, pattern] of Object.entries({ network: /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/, dynamicCode: /\b(?:eval|Function)\s*\(/ })) {
  if (pattern.test(source)) failures.push(`${name} primitive found in extension JavaScript`);
}

const context = { self: {}, encodeURIComponent };
vm.runInNewContext(fs.readFileSync(path.join(EXT, 'adapters.js'), 'utf8'), context);
const declaredHosts = (manifest.content_scripts || []).flatMap((item) => item.matches || []).join('\n');
for (const adapter of context.self.PTAdapters.ADAPTERS) {
  if (adapter.demo) continue;
  for (const domain of adapter.domains) if (!declaredHosts.includes(domain)) failures.push(`${adapter.id} adapter domain is absent from manifest: ${domain}`);
}

if (failures.length) {
  console.error(`Extension validation failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Extension validation passed (${context.self.PTAdapters.ADAPTERS.length - 1} production seller adapters, minimal permissions, local code only).`);
