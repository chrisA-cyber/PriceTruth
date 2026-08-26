import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CODE_DIRS = ['src', 'public', 'extension', 'scripts', 'test'];
const failures = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = CODE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
for (const file of files.filter((f) => /\.(?:js|mjs)$/.test(f))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(ROOT, file)}: ${result.stderr.trim()}`);
}
for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'extension')), path.join(ROOT, 'package.json')].filter((f) => f.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { failures.push(`${path.relative(ROOT, file)}: ${error.message}`); }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Source check passed (${files.filter((f) => /\.(?:js|mjs)$/.test(f)).length} scripts parsed).`);
