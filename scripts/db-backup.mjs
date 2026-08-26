import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function value(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const source = path.resolve(value('--source', process.env.PRICETRUTH_DB || 'data/pricetruth.db'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(value('--output', path.join('.backups', `pricetruth-${stamp}.db`)));
if (source === output) throw new Error('backup output must differ from the live database');
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`database not found: ${source}`);
if (fs.existsSync(output)) throw new Error(`refusing to overwrite existing backup: ${output}`);
fs.mkdirSync(path.dirname(output), { recursive: true });

const quotedOutput = output.replaceAll("'", "''");
const live = new DatabaseSync(source, { timeout: 10_000 });
try {
  live.exec('PRAGMA busy_timeout=10000');
  live.exec(`VACUUM INTO '${quotedOutput}'`);
} finally {
  live.close();
}

const backup = new DatabaseSync(output, { readOnly: true });
try {
  const check = backup.prepare('PRAGMA quick_check').get();
  if (!check || Object.values(check)[0] !== 'ok') throw new Error('backup integrity check failed');
} finally {
  backup.close();
}
const backupStat = fs.statSync(output);
const hash = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(output)) hash.update(chunk);
const digest = hash.digest('hex');
const bytes = backupStat.size;
fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`, { flag: 'wx' });
fs.writeFileSync(`${output}.json`, JSON.stringify({ created_at: new Date().toISOString(), source, output, bytes, sha256: digest }, null, 2) + '\n', { flag: 'wx' });
console.log(`Verified SQLite backup: ${output} (${bytes} bytes, sha256 ${digest.slice(0, 12)}…)`);
