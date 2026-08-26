import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const file = path.resolve(import.meta.dirname, '..', 'openapi', 'openapi.json');
const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];
if (spec.openapi !== '3.1.0') failures.push('openapi must be 3.1.0');
if (!spec.info?.version) failures.push('info.version is required');

function resolve(pointer) {
  if (!pointer.startsWith('#/')) return true;
  let value = spec;
  for (const part of pointer.slice(2).split('/').map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))) value = value?.[part];
  return value !== undefined;
}
function refs(value, at = '#') {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string' && !resolve(value.$ref)) failures.push(`unresolved ref at ${at}: ${value.$ref}`);
  for (const [key, child] of Object.entries(value)) refs(child, `${at}/${key}`);
}
refs(spec);

const ids = new Set();
for (const [route, item] of Object.entries(spec.paths || {})) {
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    const operation = item[method];
    if (!operation) continue;
    if (!operation.operationId) failures.push(`${method.toUpperCase()} ${route} lacks operationId`);
    else if (ids.has(operation.operationId)) failures.push(`duplicate operationId ${operation.operationId}`);
    else ids.add(operation.operationId);
    if (!operation.tags?.length) failures.push(`${method.toUpperCase()} ${route} lacks tags`);
    if (!operation.responses?.['200'] && !operation.responses?.['201'] && !operation.responses?.['202'] && !operation.responses?.['303']) failures.push(`${method.toUpperCase()} ${route} lacks success response`);
    if (!operation['x-idempotency']?.strategy) failures.push(`${method.toUpperCase()} ${route} lacks x-idempotency strategy`);
    if (route.startsWith('/api/v1/') && JSON.stringify(operation.security) !== JSON.stringify([{ apiKey: [] }])) failures.push(`${method.toUpperCase()} ${route} must require X-API-Key`);
  }
}
for (const required of ['Cents', 'Report', 'Completeness', 'UnknownCost', 'Error', 'Readiness', 'ApiKeyRecord']) if (!spec.components?.schemas?.[required]) failures.push(`missing schema ${required}`);
if (spec.components?.schemas?.Cents?.type !== 'integer') failures.push('money schema must use integer cents');
if (!spec.components?.schemas?.Report?.required?.includes('completeness')) failures.push('Report must require completeness');

if (failures.length) {
  console.error(`OpenAPI validation failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
const generator = path.resolve(import.meta.dirname, 'generate-openapi.mjs');
const drift = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
if (drift.status !== 0) {
  console.error((drift.stderr || drift.stdout || 'OpenAPI generator drift check failed.').trim());
  process.exit(1);
}
console.log(`OpenAPI validation passed (${Object.keys(spec.paths).length} paths, ${ids.size} operations, all references resolved).`);
