import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'postdeploy-check.mjs');

function run(url) {
  return spawnSync(process.execPath, [script, `--base-url=${url}`], {
    encoding: 'utf8',
    env: { ...process.env, PUBLIC_BASE_URL: '' },
  });
}

describe('post-deploy verifier URL boundary', () => {
  it('rejects a remote plaintext origin before making requests', () => {
    const result = run('http://deployment.example.invalid');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote post-deploy checks require HTTPS/);
  });

  it('rejects paths, query strings, fragments, and credentials', () => {
    for (const url of [
      'https://launch-operator.com/path',
      'https://launch-operator.com?preview=1',
      'https://launch-operator.com#fragment',
      'https://operator:secret@launch-operator.com',
    ]) {
      const result = run(url);
      assert.notEqual(result.status, 0, url);
      assert.match(result.stderr, /must be an origin/, url);
    }
  });

  it('rejects reserved remote hostnames before making requests', () => {
    for (const url of ['https://deployment.example.invalid', 'https://example.com']) {
      const result = run(url);
      assert.notEqual(result.status, 0, url);
      assert.match(result.stderr, /public non-reserved hostname/, url);
    }
  });
});
