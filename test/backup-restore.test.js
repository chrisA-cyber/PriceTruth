import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { integrity, restoreDatabase } from '../scripts/db-restore.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function createDatabase(file, value, payloadBytes = 0) {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE marker (value TEXT NOT NULL); CREATE TABLE payload (bytes BLOB NOT NULL)');
    db.prepare('INSERT INTO marker (value) VALUES (?)').run(value);
    db.prepare('INSERT INTO payload (bytes) VALUES (zeroblob(?))').run(payloadBytes);
  } finally { db.close(); }
}

function marker(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT value FROM marker').get().value; }
  finally { db.close(); }
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

describe('backup and restore operations', () => {
  it('streams backup hashing and records verified size/hash sidecars', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-backup-'));
    try {
      const source = path.join(temp, 'live.db');
      const output = path.join(temp, 'backup.db');
      createDatabase(source, 'source', 2 * 1024 * 1024);
      const run = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'db-backup.mjs'),
        '--source', source,
        '--output', output,
      ], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      integrity(output);
      const metadata = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'));
      assert.equal(metadata.bytes, fs.statSync(output).size);
      assert.equal(metadata.sha256, await digest(output));
      assert.match(fs.readFileSync(`${output}.sha256`, 'utf8'), new RegExp(`^${metadata.sha256}  backup\\.db\\n$`));
      const sourceText = fs.readFileSync(path.join(ROOT, 'scripts', 'db-backup.mjs'), 'utf8');
      assert.doesNotMatch(sourceText, /readFileSync\s*\(\s*output/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  it('quarantines a promoted candidate and restores the previous target when final verification fails', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-restore-rollback-'));
    try {
      const source = path.join(temp, 'backup.db');
      const target = path.join(temp, 'live.db');
      createDatabase(source, 'replacement');
      createDatabase(target, 'original');
      assert.throws(() => restoreDatabase({ source, target }, {
        checkIntegrity(file) {
          integrity(file);
          if (path.resolve(file) === path.resolve(target)) throw new Error('simulated post-promotion verification failure');
        },
      }), /restore verification failed/);
      assert.equal(marker(target), 'original');
      const failed = fs.readdirSync(temp).filter((name) => name.startsWith('live.db.failed-restore-'));
      assert.equal(failed.length, 1);
      assert.equal(marker(path.join(temp, failed[0])), 'replacement');
      assert.equal(fs.readdirSync(temp).some((name) => name.includes('.pre-restore-')), false);
      assert.equal(fs.readdirSync(temp).some((name) => name.endsWith('.tmp')), false);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  it('retains the prior verified target after a successful restore', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-restore-success-'));
    try {
      const source = path.join(temp, 'backup.db');
      const target = path.join(temp, 'live.db');
      createDatabase(source, 'replacement');
      createDatabase(target, 'original');
      const result = restoreDatabase({ source, target });
      assert.equal(marker(target), 'replacement');
      assert.ok(result.recovery);
      assert.equal(marker(result.recovery), 'original');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
});
