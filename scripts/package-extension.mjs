import fs from 'node:fs';
import path from 'node:path';
import { zip, prepareExtensionManifest } from '../src/extzip.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');
const arg = process.argv.find((value) => value.startsWith('--app-url='));
const outputArg = process.argv.find((value) => value.startsWith('--output='));
const rawUrl = arg ? arg.slice('--app-url='.length) : process.env.EXTENSION_APP_URL;
if (!rawUrl) throw new Error('set EXTENSION_APP_URL or pass --app-url=https://your-production-origin');
const appUrl = new URL(rawUrl);
if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || appUrl.pathname.replace(/\/+$/, '')) {
  throw new Error('extension app URL must be an origin-only HTTPS URL');
}
const origin = appUrl.origin;
const { hostname } = appUrl;
const files = [
  'manifest.json', 'config.js', 'adapters.js', 'feemodel.js', 'content.js', 'overlay.css',
  'popup.html', 'popup.js', 'popup.css', 'options.html', 'options.js', 'options.css',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'PRIVACY.md',
];
const entries = files.map((name) => {
  const binary = name.endsWith('.png');
  let data = fs.readFileSync(path.join(EXT, name), binary ? undefined : 'utf8');
  if (name === 'config.js') {
    data = data.replace("appUrl: 'http://localhost:4780'", `appUrl: '${origin}'`)
      .replace("demoHost: 'localhost'", `demoHost: '${hostname}'`);
  }
  if (name === 'manifest.json') {
    const manifest = JSON.parse(data);
    data = JSON.stringify(prepareExtensionManifest(manifest, origin), null, 2) + '\n';
  }
  return { name, data };
});
const dist = path.join(ROOT, 'dist');
const output = outputArg
  ? path.resolve(outputArg.slice('--output='.length))
  : path.join(dist, 'pricetruth-extension.zip');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, zip(entries));
console.log(`Wrote ${output} for ${origin}`);
