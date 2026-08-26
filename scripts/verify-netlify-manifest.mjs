// Verifies the deploy artifact produced by Netlify's own Function packager.
// This catches static-config extraction regressions that source-only tests
// cannot see (for example imported route constants or a scalar rate key).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_APP_ROUTES = ['/api/*', '/go/*', '/download/*', '/billing/*'];
const EXPECTED_EXCLUSIONS = [
  '/api/billing/webhook',
  '/api/email/webhook',
  '/api/internal/worker',
];

function methods(route) {
  return Array.isArray(route?.methods) ? route.methods : [];
}

function routePatterns(entry, key = 'routes') {
  return (entry?.[key] || []).map((route) => route.pattern).sort();
}

function sameMembers(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function zipEntryNames(buffer) {
  const minimumEocd = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Function artifact is not a readable ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Function artifact has an invalid ZIP central directory');
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error('Function artifact has a truncated ZIP entry');
    names.push(buffer.subarray(nameStart, nameEnd).toString('utf8').replaceAll('\\', '/'));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function directoryEntryNames(directory) {
  const names = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) names.push(path.relative(directory, absolute).replaceAll('\\', '/'));
    }
  };
  visit(directory);
  return names;
}

function functionArtifact(entry, manifestPath) {
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const candidates = [
    entry?.path,
    entry?.name ? `${entry.name}.zip` : null,
    entry?.name || null,
  ].filter(Boolean).map((candidate) => path.isAbsolute(candidate)
    ? candidate
    : path.resolve(manifestDirectory, candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function verifyPackagedAppFiles(manifest, manifestPath) {
  const app = (manifest?.functions || []).find((entry) => entry.name === 'app');
  if (!app) return ['app: missing from packaged Function manifest'];
  const artifact = functionArtifact(app, manifestPath);
  if (!artifact) return ['app: packaged Function artifact is missing'];
  try {
    const stat = fs.statSync(artifact);
    const names = stat.isDirectory()
      ? directoryEntryNames(artifact)
      : zipEntryNames(fs.readFileSync(artifact));
    if (!names.some((name) => name === 'public/index.html' || name.endsWith('/public/index.html'))) {
      return ['app: public/index.html is missing from the packaged Function artifact'];
    }
    return [];
  } catch (error) {
    return [`app: packaged Function artifact could not be inspected (${error.message})`];
  }
}

function verifyNetlifyManifest(manifest) {
  const failures = [];
  const functions = new Map((manifest?.functions || []).map((entry) => [entry.name, entry]));
  const requireFunction = (name) => {
    const entry = functions.get(name);
    if (!entry) failures.push(`${name}: missing from packaged Function manifest`);
    return entry;
  };

  const app = requireFunction('app');
  const webhooks = requireFunction('webhooks');
  const background = requireFunction('worker-background');
  const schedule = requireFunction('worker-schedule');

  if (app) {
    if (!sameMembers(routePatterns(app), EXPECTED_APP_ROUTES)) failures.push('app: dynamic route set is incomplete');
    if (!sameMembers(routePatterns(app, 'excludedRoutes'), EXPECTED_EXCLUSIONS)) failures.push('app: private/webhook exclusions are incomplete');
    const rate = app.trafficRules?.action?.config;
    const aggregateKeys = rate?.aggregate?.keys || [];
    if (!aggregateKeys.some((key) => key?.type === 'ip')) failures.push('app: packaged rate limit is not aggregated by IP');
    if (aggregateKeys.some((key) => key?.type === 'domain')) failures.push('app: packaged rate limit unexpectedly uses domain aggregation');
    if (rate?.rateLimitConfig?.windowLimit !== 300 || rate?.rateLimitConfig?.windowSize !== 60) {
      failures.push('app: packaged 300 request / 60 second rate limit is missing');
    }
  }

  if (webhooks) {
    const routes = webhooks.routes || [];
    if (!sameMembers(routePatterns(webhooks), EXPECTED_EXCLUSIONS.slice(0, 2)) ||
        routes.some((route) => !methods(route).includes('POST'))) {
      failures.push('webhooks: exact POST routes are missing');
    }
    if (webhooks.trafficRules) failures.push('webhooks: provider retries must not inherit the public app rate limit');
  }

  if (background) {
    const workerRoute = (background.routes || []).find((route) => route.pattern === '/api/internal/worker');
    if (background.invocationMode !== 'background') failures.push('worker-background: invocation mode is not background');
    if (!workerRoute || !methods(workerRoute).includes('POST')) failures.push('worker-background: exact POST route is missing');
    const rate = background.trafficRules?.action?.config;
    const aggregateKeys = rate?.aggregate?.keys || [];
    if (!aggregateKeys.some((key) => key?.type === 'ip')) failures.push('worker-background: packaged rate limit is not aggregated by IP');
    if (aggregateKeys.some((key) => key?.type === 'domain')) failures.push('worker-background: packaged rate limit unexpectedly uses domain aggregation');
    if (rate?.rateLimitConfig?.windowLimit !== 10 || rate?.rateLimitConfig?.windowSize !== 60) {
      failures.push('worker-background: packaged 10 request / 60 second rate limit is missing');
    }
  }

  if (schedule?.schedule !== '* * * * *') failures.push('worker-schedule: one-minute schedule is missing');
  return failures;
}

function main(argv = process.argv.slice(2)) {
  const manifestPath = path.resolve(argv[0] || '.netlify/functions/manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Netlify Function manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const failures = [
    ...verifyNetlifyManifest(manifest),
    ...verifyPackagedAppFiles(manifest, manifestPath),
  ];
  if (failures.length) {
    console.error('Netlify Function manifest verification FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('Netlify Function manifest verified: routes, webhooks, background worker, schedule, and public/private IP rate limits are correct.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { verifyNetlifyManifest, verifyPackagedAppFiles, zipEntryNames };
