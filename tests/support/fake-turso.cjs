'use strict';
/**
 * A stand-in for a Turso / libSQL server: the Hrana-over-HTTP pipeline endpoint
 * (/v2/pipeline) on top of an in-memory SQLite database. It runs in its own process
 * because the app under test blocks its own thread while it waits for the database.
 *
 *   node fake-turso.cjs <auth-token>     prints the listening port on stdout
 *
 * It follows the published protocol, so it checks that the client speaks it
 * correctly. It is not a real Turso server and does not prove how Turso behaves
 * under load or across regions.
 */
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const token = process.argv[2] || 'test-token';
const db = new DatabaseSync(':memory:');
const batons = new Set();
let counter = 0;

function decode(value) {
  switch (value.type) {
    case 'integer': return Number(value.value);
    case 'float': return value.value;
    case 'text': return value.value;
    case 'blob': return Buffer.from(value.base64, 'base64');
    default: return null;
  }
}

function encode(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  return { type: 'text', value: String(value) };
}

function execute(stmt) {
  const prepared = db.prepare(stmt.sql);
  const args = (stmt.args || []).map(decode);
  if (stmt.named_args) {
    const named = {};
    for (const { name, value } of stmt.named_args) named[name] = decode(value);
    args.push(named);
  }
  const cols = prepared.columns();
  if (cols.length) {
    const rows = prepared.all(...args);
    return {
      cols: cols.map((c) => ({ name: c.name, decltype: c.type || null })),
      rows: stmt.want_rows === false ? [] : rows.map((row) => cols.map((c) => encode(row[c.name]))),
      affected_row_count: 0,
      last_insert_rowid: null,
    };
  }
  const info = prepared.run(...args);
  return { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: info.changes ? String(info.lastInsertRowid) : null };
}

function handle(body) {
  let baton = body.baton || null;
  if (baton && !batons.has(baton)) return { status: 400, body: { error: 'The stream has expired' } };
  const results = [];
  let closed = false;
  for (const request of body.requests) {
    try {
      if (request.type === 'execute') results.push({ type: 'ok', response: { type: 'execute', result: execute(request.stmt) } });
      else if (request.type === 'sequence') {
        db.exec(request.sql);
        results.push({ type: 'ok', response: { type: 'sequence' } });
      } else if (request.type === 'close') {
        closed = true;
        results.push({ type: 'ok', response: { type: 'close' } });
      } else results.push({ type: 'error', error: { message: `Unsupported request ${request.type}` } });
    } catch (error) {
      results.push({ type: 'error', error: { message: `SQLite error: ${error.message}`, code: error.code || 'SQLITE_ERROR' } });
    }
  }
  if (closed) {
    if (baton) batons.delete(baton);
    baton = null;
  } else {
    if (!baton) {
      counter += 1;
      baton = `baton-${counter}`;
    }
    batons.add(baton);
  }
  return { status: 200, body: { baton, base_url: null, results } };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
    if (req.method !== 'POST' || req.url !== '/v2/pipeline') return send(404, { error: 'Not found' });
    try {
      const { status, body } = handle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      send(status, body);
    } catch (error) {
      send(500, { error: error.message });
    }
  });
});

server.listen(0, '127.0.0.1', () => console.log(server.address().port));
