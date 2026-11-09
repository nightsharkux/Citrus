'use strict';
/**
 * Runtime configuration. Every environment variable the server reads is listed
 * here, with its default, so there is one place to look.
 *
 * AI provider credentials are intentionally NOT copied here: the provider
 * registry reads them lazily from the environment so that keys can be rotated
 * without touching the rest of the app (and so tests can swap them).
 * Live recognition settings DEEPGRAM_API_KEY, CAMPUS_STT_PROVIDER and CAMPUS_STT_REGION
 * are read lazily by src/ai/recognition.js for the same reason.
 * WISPR_FLOW_API_KEY is read by src/ai/wispr.js when that recognition provider is selected.
 */
const path = require('node:path');
const { siteConfig } = require('../config/site');

const ROOT = path.resolve(__dirname, '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The address Campus OS is reached at. On Vercel it comes from the variables the
 * platform sets itself: the production domain in production, the deployment's own
 * address in previews. Anywhere else it is localhost, and links follow the address
 * each visitor used (see `baseUrl` in src/app.js).
 */
function resolveAddress(env, port) {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === 'production' || vercelEnv === 'preview') {
    const domain = vercelEnv === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL : env.VERCEL_URL;
    if (domain) return { url: `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`, hosted: true };
  }
  return { url: `http://localhost:${port}`, hosted: false };
}

function loadConfig(env = process.env) {
  const dbPath = env.DB_PATH || path.join(ROOT, 'storage', 'campusos.db');
  const storageDir = env.CAMPUS_STORAGE_DIR || (env.DB_PATH ? path.dirname(dbPath) : path.join(ROOT, 'storage'));
  const port = int(env.PORT, 3100);
  const host = env.HOST || '127.0.0.1';
  const { url: publicUrl, hosted } = resolveAddress(env, port);

  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    site: siteConfig(env),
    port,
    host,
    publicUrl,
    // True on Vercel. Off Vercel, links (e.g. calendar feeds) follow the address each visitor used.
    hosted,
    dbPath,
    // A hosted database (Turso) replaces the local file when TURSO_DATABASE_URL is set. See src/db/remote.js.
    database: { url: (env.TURSO_DATABASE_URL || '').trim(), authToken: (env.TURSO_AUTH_TOKEN || '').trim() },
    storageDir,
    audioDir: path.join(storageDir, 'audio'),
    cookieSecure: bool(env.COOKIE_SECURE, publicUrl.startsWith('https://')),
    // Set when Campus OS is only reachable through a reverse proxy (Caddy, nginx, a tunnel). Vercel always is one.
    trustProxy: bool(env.TRUST_PROXY, hosted),
    sessionDays: int(env.SESSION_DAYS, 7),
    logRequests: bool(env.LOG_REQUESTS, false),

    seed: {
      institution: env.CAMPUS_DEFAULT_INSTITUTION || null,
      adminEmail: env.CAMPUS_ADMIN_EMAIL || 'admin@campusos.local',
      adminPassword: env.CAMPUS_ADMIN_PASSWORD || '',
    },

    oidc: {
      issuer: (env.OIDC_ISSUER || '').replace(/\/$/, ''),
      clientId: env.OIDC_CLIENT_ID || '',
      clientSecret: env.OIDC_CLIENT_SECRET || '',
      redirectUri: env.OIDC_REDIRECT_URI || `${publicUrl}/auth/sso/callback`,
      scopes: env.OIDC_SCOPES || 'openid email profile',
      label: env.OIDC_LABEL || 'University login',
      institutionId: int(env.OIDC_INSTITUTION_ID, 1),
      autoCreate: bool(env.OIDC_AUTO_CREATE, true),
      roleClaim: env.OIDC_ROLE_CLAIM || '',
      lecturerValues: (env.OIDC_LECTURER_VALUES || 'faculty,staff,employee').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
      trustRoleClaim: bool(env.OIDC_TRUST_ROLE_CLAIM, false),
    },

    moodle: {
      url: (env.MOODLE_URL || '').replace(/\/$/, ''),
    },

    push: {
      subject: env.PUSH_SUBJECT || `mailto:${env.CAMPUS_ADMIN_EMAIL || 'admin@campusos.local'}`,
    },
  };
}

module.exports = { loadConfig, ROOT };
