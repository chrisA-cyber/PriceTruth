import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function required(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`);
  return process.argv[index + 1];
}

function integrity(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    if (!row || Object.values(row)[0] !== 'ok') throw new Error(`integrity check failed for ${file}`);
  } finally { db.close(); }
}

function uniqueSibling(target, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${target}.${label}-${stamp}`;
  if (!fs.existsSync(base)) return base;
  const withPid = `${base}-${process.pid}`;
  if (!fs.existsSync(withPid)) return withPid;
  throw new Error(`refusing to overwrite existing recovery artifact: ${withPid}`);
}

function restoreDatabase({ source: sourceInput, target: targetInput }, { checkIntegrity = integrity } = {}) {
  const source = path.resolve(sourceInput);
  const target = path.resolve(targetInput);
  if (source === target) throw new Error('backup source and restore target must differ');
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`backup not found: ${source}`);
  if (!path.isAbsolute(target) || target === path.parse(target).root) throw new Error('target must be a specific absolute database file');
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(target + suffix)) throw new Error(`live SQLite sidecar exists (${target + suffix}); stop the app cleanly before restore`);
  }

  checkIntegrity(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = `${target}.restore-${process.pid}.tmp`;
  if (fs.existsSync(stage)) throw new Error(`staging path already exists: ${stage}`);
  try {
    fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
    checkIntegrity(stage);
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage);
    throw error;
  }

  let recovery = null;
  let promoted = false;
  try {
    if (fs.existsSync(target)) {
      recovery = uniqueSibling(target, 'pre-restore');
      fs.renameSync(target, recovery);
    }
    fs.renameSync(stage, target);
    promoted = true;
    checkIntegrity(target);
  } catch (error) {
    const rollbackErrors = [];
    if (fs.existsSync(stage)) {
      try { fs.rmSync(stage); } catch (cleanupError) { rollbackErrors.push(cleanupError); }
    }
    let failedCandidate = null;
    if (promoted && fs.existsSync(target)) {
      try {
        failedCandidate = uniqueSibling(target, 'failed-restore');
        fs.renameSync(target, failedCandidate);
      } catch (quarantineError) { rollbackErrors.push(quarantineError); }
    }
    if (recovery && fs.existsSync(recovery) && !fs.existsSync(target)) {
      try { fs.renameSync(recovery, target); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], `restore failed and rollback was incomplete; recovery=${recovery || 'none'} failedCandidate=${failedCandidate || 'none'}`);
    }
    const rollbackOutcome = recovery ? 'previous target restored' : 'no previous target existed';
    throw new Error(`restore verification failed; ${rollbackOutcome}${failedCandidate ? ` and failed candidate retained at ${failedCandidate}` : ''}`, { cause: error });
  }
  return { target, recovery };
}

function main() {
  if (!process.argv.includes('--confirm-restore')) throw new Error('restore is destructive; stop the app, then add --confirm-restore');
  const result = restoreDatabase({ source: required('--source'), target: required('--target') });
  console.log(`Restore verified: ${result.target}`);
  if (result.recovery) console.log(`Previous database retained for rollback: ${result.recovery}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { integrity, restoreDatabase };
