import { isPublicHostname } from '../../src/security.js';

const NON_PUBLISHED_CONTEXTS = new Set([
  'branch-deploy',
  'deploy-preview',
  'preview-server',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeDeploymentOrigin(value, {
  allowLoopbackHttp = false,
  label = 'Netlify deployment origin',
} = {}) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} must be a valid public origin-only HTTPS URL`);
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  const publicHttps = url.protocol === 'https:' && isPublicHostname(url.hostname);
  if ((!publicHttps && !loopbackHttp) ||
      url.username || url.password ||
      (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`${label} must be a public origin-only HTTPS URL${allowLoopbackHttp ? ' or an HTTP loopback origin in Netlify Dev' : ''}`);
  }
  return url.origin;
}

function normalizePublicHttpsOrigin(value, label = 'Netlify deployment origin') {
  return normalizeDeploymentOrigin(value, { label });
}

function publicationState(context = {}) {
  const deployContext = String(context.deploy?.context || '').trim();
  if (NON_PUBLISHED_CONTEXTS.has(deployContext)) return false;
  if (deployContext === 'production') return context.deploy?.published !== false;
  if (typeof context.deploy?.published === 'boolean') return context.deploy.published;
  return null;
}

function resolveDeploymentOrigin(request, context = {}, {
  configuredOrigin = process.env.PUBLIC_BASE_URL,
  netlifySiteOrigin = context.site?.url || process.env.URL,
  trustProductionSchedule = false,
} = {}) {
  let published = publicationState(context);
  const deployContext = String(context.deploy?.context || '').trim();

  // Scheduled Functions can report `published: false` even though automatic
  // schedules only run for the published production deploy. Permit that narrow
  // scheduled-only caller to trust the exact production context. Netlify may
  // use an internal request origin for the clock, so the destination is still
  // resolved independently from the validated configured/main site origin
  // below. Never apply this exception to ordinary web or background Functions:
  // skew protection can route old production code through the main hostname.
  if (trustProductionSchedule && published === false && deployContext === 'production') published = true;
  const localDev = deployContext === 'dev' && published === false && process.env.NETLIFY_DEV === 'true';

  // The pinned Netlify CLI supplies all four signals below. Requiring all of
  // them means a dashboard variable cannot enable HTTP or a private hostname in
  // a real deploy, while `netlify dev` can still use its loopback proxy.
  if (localDev) {
    const current = new URL(request.url);
    const currentOrigin = normalizeDeploymentOrigin(current.origin, {
      allowLoopbackHttp: true,
      label: 'local Netlify Dev request origin',
    });
    const site = new URL(String(netlifySiteOrigin || ''));
    normalizeDeploymentOrigin(site.origin, {
      allowLoopbackHttp: true,
      label: 'local Netlify Dev site origin',
    });
    if (!LOOPBACK_HOSTS.has(current.hostname) || !LOOPBACK_HOSTS.has(site.hostname) ||
        current.port !== site.port) {
      throw new Error('local Netlify Dev request and site origins must use the same loopback port');
    }
    return { origin: currentOrigin, localDev: true, published };
  }

  // context.site.url and URL always name the site's main address, including
  // while code is running in a Deploy Preview or branch deploy. Non-published
  // code must instead stay on the exact HTTPS deploy origin that Netlify put in
  // the Fetch Request; otherwise preview tokens are created in one database
  // branch but sent to production, and same-origin CSRF checks reject the UI.
  if (published === false) {
    const currentOrigin = normalizePublicHttpsOrigin(
      new URL(request.url).origin,
      'current non-published Netlify deploy origin',
    );
    if (netlifySiteOrigin) {
      const mainOrigin = normalizePublicHttpsOrigin(netlifySiteOrigin, 'Netlify main site origin');
      if (currentOrigin === mainOrigin) {
        throw new Error('a non-published Netlify deploy cannot use the main production site origin');
      }
    }
    return { origin: currentOrigin, localDev: false, published };
  }

  if (String(configuredOrigin || '').trim()) {
    return { origin: normalizePublicHttpsOrigin(configuredOrigin, 'PUBLIC_BASE_URL'), localDev: false, published };
  }
  if (netlifySiteOrigin) {
    return { origin: normalizePublicHttpsOrigin(netlifySiteOrigin, 'Netlify main site origin'), localDev: false, published };
  }
  if (published === true) {
    throw new Error('published Netlify production requires a trusted main site origin');
  }
  return {
    origin: normalizePublicHttpsOrigin(new URL(request.url).origin, 'Netlify request origin'),
    localDev: false,
    published,
  };
}

function deploymentOrigin(request, context = {}, options = {}) {
  return resolveDeploymentOrigin(request, context, options).origin;
}

export {
  NON_PUBLISHED_CONTEXTS,
  deploymentOrigin,
  normalizeDeploymentOrigin,
  normalizePublicHttpsOrigin,
  publicationState,
  resolveDeploymentOrigin,
};
