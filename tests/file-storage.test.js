'use strict';
/**
 * File storage (Vercel Blob, src/services/blob.js) against a stand-in store that checks what the real one checks:
 * the server's token for its own requests, and for the browser an upload pass that allows one exact path, size and
 * type. Big course files and meeting recordings go straight from the browser to the store; downloads come back
 * through Campus OS after its access check; the store is never readable without the token.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startApp } = require('./helpers');
const { createBlobStore } = require('../src/services/blob');

const TOKEN = 'vercel_blob_rw_teststore123_s3cretpart';
const OIDC = 'oidc.jwt.from-vercel';
const SIGNING_SECRET = 'fake-store-signing-secret';
const b64url = (s) => Buffer.from(s).toString('base64url');
// The headers Vercel Blob allows from a browser on another site (its answer to the CORS preflight, 16 Nov 2026).
// A browser upload with any other header never leaves the browser.
const CORS_HEADERS = 'authorization,content-type,x-api-version,x-mpu-action,x-mpu-key,x-mpu-upload-id,x-mpu-part-number,x-content-type,x-proxy-through-alternative-api,x-api-blob-request-id,x-api-blob-request-attempt,x-content-length,x-vercel-blob-access,x-vercel-blob-store-kind,x-vercel-blob-store-id,x-vercel-blob-team-id,x-if-match'.split(',');
const NOT_FROM_A_BROWSER = new Set(['host', 'connection', 'content-length', 'accept', 'accept-encoding', 'accept-language', 'user-agent', 'sec-fetch-mode', 'origin']);

/**
 * A stand-in Blob store: PUT /api/blob/?pathname=…, GET /<pathname> (with the token), POST /api/blob/delete, and for
 * OIDC stores POST /api/blob/signed-token and presigned PUTs (checked the way the SDK signs them).
 */
async function startFakeBlob() {
  const files = new Map();
  const log = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const fail = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'forbidden', message } }));
    };
    const server = auth === TOKEN || (auth === OIDC && req.headers['x-vercel-blob-store-id'] === 'teststore123');
    const presigned = url.searchParams.has('vercel-blob-signature');
    log.push({ method: req.method, path: url.pathname, auth: presigned ? 'presigned' : auth.startsWith('vercel_blob_client_') ? 'client' : server ? (auth === OIDC ? 'oidc' : 'server') : 'none' });
    if (req.method === 'POST' && url.pathname === '/api/blob/signed-token') {
      if (!server) return fail(403, 'no token');
      const b = JSON.parse(body);
      const delegationToken = `${b64url(JSON.stringify({ storeId: 'store_teststore123', ...b }))}.sig`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ delegationToken, clientSigningToken: crypto.createHmac('sha256', SIGNING_SECRET).update(delegationToken).digest('hex'), validUntil: b.validUntil }));
    }
    if (req.method === 'PUT' && url.pathname === '/api/blob/') {
      const pathname = url.searchParams.get('pathname');
      // Uploads from the browser (a client token or a signed address) may only carry the allowed headers.
      if (presigned || auth.startsWith('vercel_blob_client_')) {
        const extra = Object.keys(req.headers).filter((h) => !CORS_HEADERS.includes(h) && !NOT_FROM_A_BROWSER.has(h));
        if (extra.length) return fail(400, `a browser could not send these headers (CORS): ${extra.join(', ')}`);
      }
      if (req.headers['x-vercel-blob-access'] !== 'private') return fail(400, 'access must be private here');
      if (presigned) {
        const delegation = url.searchParams.get('vercel-blob-delegation');
        const scope = JSON.parse(Buffer.from(delegation.split('.')[0], 'base64url').toString());
        const lines = ['operation=put', `pathname=${pathname}`];
        for (const [k, v] of url.searchParams) if (k.startsWith('vercel-blob-') && !['vercel-blob-delegation', 'vercel-blob-signature'].includes(k) && v) lines.push(`${k}=${v}`);
        lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const key = crypto.createHmac('sha256', SIGNING_SECRET).update(delegation).digest('hex');
        if (crypto.createHmac('sha256', key).update(lines.join('\n')).digest('base64url') !== url.searchParams.get('vercel-blob-signature')) return fail(403, 'bad signature');
        if (auth) return fail(400, 'a presigned upload sends no token');
        if (scope.pathname !== pathname || !scope.operations.includes('put')) return fail(400, 'pathname does not match the token payload');
        if (scope.validUntil < Date.now()) return fail(400, 'Token expired');
        if (body.length > Math.min(scope.maximumSizeInBytes, Number(url.searchParams.get('vercel-blob-maximum-size-in-bytes')))) return fail(400, 'the file length cannot be greater than allowed');
        if (!scope.allowedContentTypes.includes(req.headers['x-content-type'])) return fail(400, 'contentType is not allowed');
      } else if (auth.startsWith('vercel_blob_client_')) {
        const [signature, payload] = Buffer.from(auth.split('_').pop(), 'base64').toString().split('.');
        const want = crypto.createHmac('sha256', TOKEN).update(payload).digest('hex');
        if (signature !== want) return fail(403, 'bad client token');
        const p = JSON.parse(Buffer.from(payload, 'base64').toString());
        if (p.pathname !== pathname) return fail(400, 'pathname does not match the token payload');
        if (p.validUntil < Date.now()) return fail(400, 'Token expired');
        if (body.length > p.maximumSizeInBytes) return fail(400, 'the file length cannot be greater than allowed');
        if (!p.allowedContentTypes.includes(req.headers['x-content-type'])) return fail(400, 'contentType is not allowed');
      } else if (!server) return fail(403, 'no token');
      if (files.has(pathname)) return fail(400, 'already exists');
      files.set(pathname, { body, type: req.headers['x-content-type'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ url: `${origin}/${pathname}`, pathname, contentType: req.headers['x-content-type'] }));
    }
    if (req.method === 'POST' && url.pathname === '/api/blob/delete') {
      if (!server) return fail(403, 'no token');
      for (const u of JSON.parse(body).urls) files.delete(new URL(u).pathname.slice(1));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (req.method === 'GET') {
      if (auth !== TOKEN && auth !== OIDC) return fail(403, 'private');
      const f = files.get(url.pathname.slice(1));
      if (!f) return fail(404, 'not found');
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Number(range[2]) : f.body.length - 1;
        res.writeHead(206, { 'content-type': f.type, 'content-length': to - from + 1, 'content-range': `bytes ${from}-${to}/${f.body.length}` });
        return res.end(f.body.subarray(from, to + 1));
      }
      res.writeHead(200, { 'content-type': f.type, 'content-length': f.body.length });
      return res.end(f.body);
    }
    return fail(404, 'no route');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { files, log, origin, api: `${origin}/api/blob`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** What the browser does (api.uploadDirect): pass, upload to the store, receipt. */
async function uploadDirect(app, who, start, finish, bytes, fields) {
  const s = await app.call(who, 'POST', start, { size: bytes.length, ...fields });
  if (s.status !== 200) return s;
  const put = await fetch(s.body.pass.url, { method: 'PUT', headers: { ...s.body.pass.headers, ...(s.body.pass.token ? { authorization: `Bearer ${s.body.pass.token}` } : {}), 'x-content-type': s.body.contentType }, body: bytes });
  const stored = await put.json();
  if (!put.ok) return { status: put.status, body: stored };
  return app.call(who, 'POST', finish, { ticket: s.body.ticket, url: stored.url });
}

async function setup(env = {}, { oidc = false } = {}) {
  const blob = await startFakeBlob();
  const fixture = { calls: [] };
  const fetchImpl = async (url, options) => {
    fixture.calls.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: 'We agreed to meet on Friday.' } }] });
  };
  const app = await startApp({ env: { ...(oidc ? { BLOB_STORE_ID: 'store_teststore123' } : { BLOB_READ_WRITE_TOKEN: TOKEN }), VERCEL_BLOB_API_URL: blob.api, AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway', ...env }, fetchImpl });
  // On Vercel every request carries the project's OIDC token; the stand-in app gets it the same way.
  if (oidc) {
    const call = app.call;
    app.call = (who, method, path, body, options = {}) => call(who, method, path, body, { ...options, headers: { 'x-vercel-oidc-token': OIDC, ...(options.headers || {}) } });
    app.callWithoutOidc = call;
  }
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Linear Algebra', code: 'MA2' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  await app.register('ann');
  await app.call('ann', 'POST', `/api/courses/${course.body.id}/enroll`);
  await app.register('newbie');
  const close = async () => {
    await app.close();
    await blob.close();
  };
  return { app, blob, courseId: course.body.id, close };
}

test('big course files go straight to private storage and come back only through the access check', async () => {
  const { app, blob, courseId, close } = await setup();
  try {
    const outline = await app.call('prof', 'GET', `/api/courses/${courseId}/outline`);
    assert.deepEqual(outline.body.storage, { direct: true, maxBytes: 100 * 1024 * 1024 });
    const topic = await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Eigenvalues' });

    // 6 MB: more than one request to the hosting may carry, so it could never go through Campus itself.
    const big = Buffer.concat([Buffer.from('Eigenvalues: Av = λv. '), Buffer.alloc(6 * 1024 * 1024, 'x')]);
    const added = await uploadDirect(app, 'prof', `/api/courses/${courseId}/files/start`, `/api/courses/${courseId}/files/finish`, big, { name: 'Week 3 / notes.txt', type: 'text/plain', section_id: topic.body.id });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.size, big.length);
    assert.equal(added.body.readable, true, 'Campus read its text');
    const row = app.db.get('SELECT * FROM course_items WHERE id = ?', added.body.id);
    assert.equal(row.data, '', 'not in the database');
    assert.match(row.blob_url, new RegExp(`^${blob.origin}/courses/${courseId}/[0-9a-f-]{36}/Week-3-notes\\.txt$`));
    assert.equal(row.section_id, topic.body.id);
    assert.equal(row.title, 'Week 3 - notes.txt');
    assert.ok(blob.log.some((l) => l.method === 'PUT' && l.auth === 'client'), 'the browser uploaded with a pass, not the token');

    // The store itself is private.
    assert.equal((await fetch(row.blob_url)).status, 403);
    // Members download it through Campus; others cannot.
    const got = await app.call('ann', 'GET', `/api/course-items/${added.body.id}/file`, undefined, { raw: true });
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-disposition'), /^attachment; filename="Week 3 - notes.txt"/);
    assert.equal(Buffer.from(await got.arrayBuffer()).equals(big), true);
    assert.equal((await app.call('newbie', 'GET', `/api/course-items/${added.body.id}/file`)).status, 403);

    // A pass is for one path, size and type only, and a receipt only for its own course and person.
    const start = await app.call('prof', 'POST', `/api/courses/${courseId}/files/start`, { name: 'a.pdf', size: 10, type: 'application/pdf' });
    const tooBig = await fetch(start.body.pass.url, { method: 'PUT', headers: { ...start.body.pass.headers, authorization: `Bearer ${start.body.pass.token}`, 'x-content-type': 'application/pdf' }, body: Buffer.alloc(11) });
    assert.equal(tooBig.status, 400);
    const otherPath = start.body.pass.url.replace(/pathname=[^&]+/, 'pathname=courses%2F1%2Fmine.pdf');
    assert.equal((await fetch(otherPath, { method: 'PUT', headers: { ...start.body.pass.headers, authorization: `Bearer ${start.body.pass.token}`, 'x-content-type': 'application/pdf' }, body: Buffer.alloc(5) })).status, 400);
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/files/finish`, { ticket: start.body.ticket })).status, 400, 'nothing arrived');
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/files/finish`, { ticket: `${start.body.ticket}x` })).status, 400, 'a forged receipt');
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/files/finish`, { ticket: start.body.ticket, url: 'https://evil.example/courses/x' })).status, 400);
    assert.equal((await app.call('ann', 'POST', `/api/courses/${courseId}/files/start`, { name: 'a.pdf', size: 10, type: 'application/pdf' })).status, 403, 'only the lecturer');
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/files/start`, { name: 'huge.mp4', size: 101 * 1024 * 1024, type: 'video/mp4' })).status, 400);

    // Deleting the file deletes it in the store too.
    await app.call('prof', 'DELETE', `/api/course-items/${added.body.id}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(blob.files.size, 0);
  } finally {
    await close();
  }
});

test('meeting recordings of any length are kept in storage; lecture audio from the app too, as one file', async () => {
  const { app, blob, courseId, close } = await setup();
  try {
    const space = (await app.call('prof', 'POST', '/api/workspaces', { title: 'Project meeting', kind: 'meeting' })).body;
    const room = await app.call('prof', 'GET', `/api/workspaces/${space.id}`);
    assert.deepEqual(room.body.storage, { direct: true });

    const audio = Buffer.alloc(5 * 1024 * 1024, 3);
    const saved = await uploadDirect(app, 'prof', `/api/workspaces/${space.id}/recordings/start`, `/api/workspaces/${space.id}/recordings/finish`, audio, { type: 'audio/webm', duration_ms: 3_600_000 });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const rec = app.db.get('SELECT * FROM meeting_recordings WHERE id = ?', saved.body.id);
    assert.equal(rec.bytes, audio.length);
    assert.equal(rec.duration_ms, 3_600_000);
    assert.ok(rec.blob_url.startsWith(`${blob.origin}/meetings/${space.id}/`));
    const played = await app.call('prof', 'GET', `/api/workspaces/recordings/${saved.body.id}/audio`, undefined, { raw: true, headers: { range: 'bytes=0-99' } });
    assert.equal(played.status, 206, 'seeking works');
    assert.equal(played.headers.get('content-range'), `bytes 0-99/${audio.length}`);
    assert.equal((await played.arrayBuffer()).byteLength, 100);
    await app.call('prof', 'DELETE', `/api/workspaces/recordings/${saved.body.id}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal([...blob.files.keys()].filter((k) => k.startsWith('meetings/')).length, 0);

    // Lecture audio from the Android app: kept (with the transcript), offered as one file to the lecturer.
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Eigenvalues' })).body.session.id;
    const piece = (n) => Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.alloc(3000, n)]);
    for (const [i, at] of [[2, 60_000], [1, 120_000]]) { // the earlier piece arrives last (it waited for a signal)
      const sent = await app.call('prof', 'POST', `/api/live/sessions/${sid}/audio`, piece(i), { headers: { 'content-type': 'audio/aac', 'x-recorded-at': new Date(Date.now() - at).toISOString(), 'x-duration-ms': '30000' } });
      assert.equal(sent.status, 200);
    }
    const report = await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`);
    assert.deepEqual(report.body.recording, { pieces: 2, seconds: 60 });
    const whole = await app.call('prof', 'GET', `/api/live/sessions/${sid}/recording.aac`, undefined, { raw: true });
    assert.equal(whole.status, 200);
    const bytes = Buffer.from(await whole.arrayBuffer());
    assert.equal(bytes.length, 6004);
    assert.equal(bytes[2], 1, 'in the order it was recorded, not the order it arrived');
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/recording.aac`)).status, 403);
    // Deleting the transcript deletes the audio too.
    await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/transcript`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal([...blob.files.keys()].filter((k) => k.startsWith('live/')).length, 0);
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`)).body.recording, null);
  } finally {
    await close();
  }
});

test('without a store nothing changes, and the store never fetches an address that is not its own', async () => {
  const off = createBlobStore({ env: {} });
  assert.equal(off.enabled, false);
  const store = createBlobStore({ env: { BLOB_READ_WRITE_TOKEN: TOKEN } });
  assert.equal(store.owns('https://teststore123.private.blob.vercel-storage.com/courses/1/a.pdf'), true);
  assert.equal(store.owns('https://otherstore.private.blob.vercel-storage.com/a.pdf'), false);
  assert.equal(store.owns('http://teststore123.private.blob.vercel-storage.com/a.pdf'), false);
  assert.equal(store.owns('https://evil.example/teststore123.private.blob.vercel-storage.com'), false);
  await assert.rejects(store.get('https://evil.example/x'));
  const ticket = store.ticket({ kind: 'course-file', courseId: 1 });
  assert.deepEqual({ ...store.readTicket(ticket), until: 0 }, { kind: 'course-file', courseId: 1, until: 0 });
  assert.equal(createBlobStore({ env: { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore123_other' } }).readTicket(ticket), null, 'signed with the token');

  const { app, courseId, close } = await setup({ BLOB_READ_WRITE_TOKEN: '' });
  try {
    const outline = await app.call('prof', 'GET', `/api/courses/${courseId}/outline`);
    assert.deepEqual(outline.body.storage, { direct: false, maxBytes: 4 * 1024 * 1024 });
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/files/start`, { name: 'a.pdf', size: 10, type: 'application/pdf' })).status, 400);
  } finally {
    await close();
  }
});

test('stores made since 2026 sign in with the OIDC token of each request; the browser uploads to a presigned address', async () => {
  const { app, blob, courseId, close } = await setup({}, { oidc: true });
  try {
    const outline = await app.call('prof', 'GET', `/api/courses/${courseId}/outline`);
    assert.equal(outline.body.storage.direct, true);
    const big = Buffer.concat([Buffer.from('Eigenvalues: Av = λv. '), Buffer.alloc(5 * 1024 * 1024, 'y')]);
    const start = await app.call('prof', 'POST', `/api/courses/${courseId}/files/start`, { name: 'notes.txt', size: big.length, type: 'text/plain' });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(start.body.pass.token, undefined, 'no token for the browser: the address is signed');
    assert.doesNotMatch(JSON.stringify(start.body), /fake-store-signing-secret|clientSigningToken/, 'the signing key stays on the server');
    const signed = new URL(start.body.pass.url);
    assert.equal(signed.searchParams.get('vercel-blob-maximum-size-in-bytes'), String(big.length));
    assert.equal(signed.searchParams.get('vercel-blob-allowed-content-types'), 'text/plain');
    // Changing the signed address breaks it.
    const bigger = new URL(signed);
    bigger.searchParams.set('vercel-blob-maximum-size-in-bytes', String(big.length * 2));
    assert.equal((await fetch(bigger, { method: 'PUT', headers: { ...start.body.pass.headers, 'x-content-type': 'text/plain' }, body: big })).status, 403);

    const added = await uploadDirect(app, 'prof', `/api/courses/${courseId}/files/start`, `/api/courses/${courseId}/files/finish`, big, { name: 'notes.txt', type: 'text/plain' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.readable, true);
    assert.ok(blob.log.some((l) => l.method === 'PUT' && l.auth === 'presigned'));
    assert.ok(blob.log.some((l) => l.path === '/api/blob/signed-token' && l.auth === 'oidc'));
    const got = await app.call('ann', 'GET', `/api/course-items/${added.body.id}/file`, undefined, { raw: true });
    assert.equal(Buffer.from(await got.arrayBuffer()).equals(big), true);

    // Without Vercel's token (OIDC not turned on) it says what to do instead of failing silently.
    const none = await app.callWithoutOidc('prof', 'POST', `/api/courses/${courseId}/files/start`, { name: 'a.txt', size: 3, type: 'text/plain' });
    assert.equal(none.status, 503);
    assert.match(none.body.error, /OIDC/);

    await app.call('prof', 'DELETE', `/api/course-items/${added.body.id}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(blob.files.size, 0);
  } finally {
    await close();
  }
});
