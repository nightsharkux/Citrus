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
 * With no dedicated STT configured, src/ai/recognition.js uses OpenAI live transcription through AI_GATEWAY_API_KEY.
 * CAMPUS_AI_SPEECH_STREAMING=off disables streaming playback; buffered speech remains available.
 */
const fs = require('node:fs');
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
 * The address Citrus is reached at. On Vercel it comes from the variables the
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

/**
 * Will accounts and data survive a restart? Hosting platforms that run the app as short-lived instances (Vercel and
 * similar) have no permanent disk, so a local SQLite file starts empty again after every restart or deploy: people
 * "forget" their account and have to register again. Durable means a hosted database is set, or the owner says the
 * disk is permanent (CAMPUS_PERSISTENT_DISK=1, for a mounted volume), or the app is not on such a platform.
 */
function persistence(env, database) {
  if (database.url) return { durable: true };
  if (bool(env.CAMPUS_PERSISTENT_DISK, false)) return { durable: true };
  const platform = [['VERCEL', 'Vercel'], ['NETLIFY', 'Netlify'], ['AWS_LAMBDA_FUNCTION_NAME', 'AWS Lambda'], ['K_SERVICE', 'Google Cloud Run'], ['RENDER', 'Render'], ['DYNO', 'Heroku'], ['RAILWAY_ENVIRONMENT', 'Railway']].find(([name]) => env[name]);
  if (!platform) return { durable: true };
  return { durable: false, platform: platform[1] };
}

/**
 * The database used to be called campusos.db. A folder that has one and no citrus.db yet gets it renamed (with its
 * -wal and -shm files), once, before it is opened: nothing is copied, nothing is lost, and nothing happens on a
 * server without a disk.
 */
function carryOverOldDatabaseName(storage) {
  try {
    const from = path.join(storage, 'campusos.db');
    const to = path.join(storage, 'citrus.db');
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(from + suffix)) fs.renameSync(from + suffix, to + suffix);
    }
  } catch {
    /* read-only or in use: the old name keeps being used below */
  }
}

function loadConfig(env = process.env) {
  if (!env.DB_PATH) carryOverOldDatabaseName(path.join(ROOT, 'storage'));
  const oldOnly = !env.DB_PATH && !fs.existsSync(path.join(ROOT, 'storage', 'citrus.db')) && fs.existsSync(path.join(ROOT, 'storage', 'campusos.db'));
  const dbPath = env.DB_PATH || path.join(ROOT, 'storage', oldOnly ? 'campusos.db' : 'citrus.db');
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
    persistence: persistence(env, { url: (env.TURSO_DATABASE_URL || '').trim() }),
    storageDir,
    audioDir: path.join(storageDir, 'audio'),
    cookieSecure: bool(env.COOKIE_SECURE, publicUrl.startsWith('https://')),
    // Set when Citrus is only reachable through a reverse proxy (Caddy, nginx, a tunnel). Vercel always is one.
    trustProxy: bool(env.TRUST_PROXY, hosted),
    sessionDays: int(env.SESSION_DAYS, 30),
    logRequests: bool(env.LOG_REQUESTS, false),

    seed: {
      institution: env.CAMPUS_DEFAULT_INSTITUTION || null,
      adminEmail: env.CAMPUS_ADMIN_EMAIL || 'admin@citrus.local',
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
      subject: env.PUSH_SUBJECT || `mailto:${env.CAMPUS_ADMIN_EMAIL || 'admin@citrus.local'}`,
    },
  };
}

module.exports = { carryOverOldDatabaseName, loadConfig, ROOT };
