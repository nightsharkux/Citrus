'use strict';
/**
 * Composition root. Builds shared services once, registers every feature
 * module on the router, and returns the HTTP request handler.
 *
 * Adding a feature:
 *   1. Create src/modules/<feature>/routes.js exporting register(router, deps).
 *   2. Add it to MODULES below.
 *   3. Add an entry to config/capabilities.js and a test in tests/.
 */
const { Router } = require('./http/router');
const { HttpError } = require('./http/errors');
const { readJson, readRaw } = require('./http/body');
const { applySecurityHeaders, isCrossSite, clientIp } = require('./http/security');
const { createStaticServer } = require('./http/static');
const { createBus } = require('./realtime/bus');
const { createSecretBox } = require('./lib/crypto');
const { createKeys } = require('./services/keys');
const { createAiService } = require('./ai/service');
const { createContextBuilder } = require('./ai/context');
const { createAcademicSnapshot } = require('./ai/academic-snapshot');
const { readBundled } = require('./lib/bundled');
const { createAccess } = require('./services/access');
const { createAudit } = require('./services/audit');
const { createSettings } = require('./services/settings');
const { createRooms } = require('./services/rooms');
const { createMaintenance } = require('./services/maintenance');
const { createSessions } = require('./modules/auth/sessions');
const { createOidc } = require('./modules/auth/oidc');
const { createPushSender } = require('./modules/notifications/webpush');
const { createNotifier } = require('./modules/notifications/service');
const { createTimetable } = require('./modules/timetable/service');
const { createStudyGroups } = require('./modules/groups/service');
const { createCampusPosts } = require('./modules/connect/routes');
const { createReview } = require('./modules/study/review');
const { createParticipation } = require('./modules/participation/service');
const { createDeviceCommands } = require('./modules/devices/commands');
const { createMoodleConnector } = require('./connectors/moodle');

const MODULES = [
  require('./modules/meta/routes'),
  require('./modules/auth/routes'),
  require('./modules/account/routes'),
  require('./modules/courses/routes'),
  require('./modules/study/routes'),
  require('./modules/quiz/routes'),
  require('./modules/timetable/routes'),
  require('./modules/assistant/routes'),
  require('./modules/speech/routes'),
  require('./modules/workspaces/routes'),
  require('./modules/insights/routes'),
  require('./modules/knowledge/routes'),
  require('./modules/connect/routes'),
  require('./modules/groups/routes'),
  require('./modules/notifications/routes'),
  require('./modules/participation/routes'),
  require('./modules/careers/routes'),
  require('./modules/campus/routes'),
  require('./modules/devices/routes'),
  require('./modules/integrations/routes'),
  require('./modules/admin/routes'),
];

function createApp({ config, db, env = process.env, fetchImpl }) {
  const site = config.site;
  const timeZone = site.timezone;

  // --- Shared services (dependency container passed to every module) ---
  const access = createAccess(db);
  const bus = createBus({ canSee: access.canSee });
  const audit = createAudit(db);
  const settings = createSettings(db);
  const keys = createKeys({ config, db, env });
  const secretBox = createSecretBox(keys.master());
  const nfcKey = keys.nfc();
  const packs = env.CAMPUS_BUNDLED_KNOWLEDGE === 'off' ? [] : [].concat(site.knowledgePack || []);
  const programmes = site.academicSnapshot && env.CAMPUS_BUNDLED_KNOWLEDGE !== 'off'
    ? createAcademicSnapshot({ root: config.root, file: site.academicSnapshot }) : null;
  const ai = createAiService({ db, env, fetchImpl, packs, academic: programmes, readPack: (file) => readBundled(config.root, file) });
  const push = createPushSender({ storageDir: config.storageDir, storedKeys: keys.vapid(), subject: config.push.subject, fetchImpl, allowAnyEndpoint: env.PUSH_ALLOW_ANY_ENDPOINT === '1' });
  const notifier = createNotifier({ db, bus, push, timeZone });
  const timetable = createTimetable({ db, timeZone });
  const studyGroups = createStudyGroups({ db, notifier });
  const campusPosts = createCampusPosts({ db, notifier });
  const review = createReview({ db });
  const participation = createParticipation({ db });
  const deviceCommands = createDeviceCommands({ db });
  const rooms = createRooms({ db, bus, audit, deviceCommands });
  const sessions = createSessions({ db, config });
  const oidc = createOidc({ db, config, ...(fetchImpl ? { fetchImpl } : {}) });
  const moodle = createMoodleConnector({ baseUrl: config.moodle.url, ...(fetchImpl ? { fetchImpl } : {}) });
  const buildContext = createContextBuilder({ db, timetable, timeZone, programmes, studyGroups });
  const maintenance = createMaintenance({ db, config, settings });

  const deps = {
    db, config, site, env, access, bus, audit, settings, secretBox, nfcKey, ai, push, notifier,
    timetable, studyGroups, campusPosts, review, participation, deviceCommands, rooms, sessions, oidc, moodle, buildContext, programmes,
  };

  const router = new Router();
  for (const mod of MODULES) mod.register(router, deps);
  const statics = createStaticServer({ publicDir: config.publicDir, site });
  const allowedOrigins = [new URL(config.publicUrl).origin];

  /** The address this visitor used (the Vercel address wins when hosted there). */
  function baseUrl(req) {
    if (config.hosted) return config.publicUrl;
    const host = String(req.headers.host || '');
    if (!/^[\w.-]+(:\d+)?$|^\[[\da-f:]+\](:\d+)?$/i.test(host)) return config.publicUrl;
    const proto = config.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }

  async function handler(req, res) {
    const startedAt = Date.now();
    applySecurityHeaders(res, { secure: config.cookieSecure });
    if (config.logRequests) res.on('finish', () => console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - startedAt}ms`));

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Invalid path' });
    }
    const originalPath = url.pathname;
    const method = req.method;

    try {
      let matched = router.match(method, originalPath);
      // /api/v1/* is an alias of /api/* for clients that pin the API version.
      if (!matched && originalPath.startsWith('/api/v1/')) matched = router.match(method, `/api/${originalPath.slice('/api/v1/'.length)}`);

      if (matched?.route) {
        const { route, params } = matched;
        const authMode = route.options.auth || 'user';
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && authMode !== 'device' && isCrossSite(req, allowedOrigins)) {
          throw new HttpError(403, 'Cross-site request rejected');
        }
        const user = authMode === 'device' ? null : sessions.identify(req);
        if (authMode === 'user' && !user) throw new HttpError(401, 'Please sign in');
        if (route.options.roles && !route.options.roles.includes(user?.role)) throw new HttpError(403, 'You do not have access to this');

        const ctx = {
          req,
          res,
          method,
          path: route.pattern,
          originalPath,
          params,
          query: url.searchParams,
          user,
          ip: clientIp(req, config.trustProxy),
          baseUrl: baseUrl(req),
          status: 200,
          json: (max) => readJson(req, max || route.options.maxBody || 100_000),
          raw: (max) => readRaw(req, max || 100_000),
          redirect(location) {
            res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
            res.end();
          },
        };
        const result = await route.handler(ctx);
        if (!res.headersSent && !res.writableEnded) sendJson(res, ctx.status, result === undefined ? { ok: true } : result);
      } else if (matched?.allowed) {
        sendJson(res, 405, { error: 'Method not allowed' });
      } else if (originalPath.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Endpoint not found' });
      } else if (!statics.serve(req, res, originalPath)) {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      if (res.headersSent) {
        res.end();
      } else if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) });
      } else if (error && /UNIQUE constraint failed/.test(error.message)) {
        sendJson(res, 409, { error: 'This already exists' });
      } else {
        console.error(`${method} ${originalPath} failed:`, error);
        sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
      }
    }
  }

  return { handler, router, deps, maintenance };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

module.exports = { createApp };
