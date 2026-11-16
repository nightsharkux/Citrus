'use strict';
/**
 * Hosted database driver: SQLite over HTTP ("Hrana"), as served by Turso / libSQL.
 *
 * The rest of Campus OS talks to the database synchronously (`db.get(...)`), and
 * Node has no synchronous network client. So requests are made by a small worker
 * thread, and the calling thread sleeps on `Atomics.wait` until the worker has the
 * answer. The SQL, the migrations and every module stay exactly as they are.
 *
 * Trade-off: while a query is in flight this process handles nothing else, so the
 * database should be in the same region as the server. Each Vercel instance is a
 * separate process, so instances do not block each other.
 *
 * Transactions run on one server-side stream (the "baton"). Statements that do not
 * return data are held back and sent together with the next query, so a migration
 * costs a few round trips instead of one per statement.
 */
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { addIntrospection } = require('./introspection');

const TIMEOUT_MS = 30_000;

/**
 * Worker source, kept as a string so it survives bundlers that rewrite or
 * precompile files. It posts a result back, then wakes the waiting thread.
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const { port, flag, url, authToken, timeoutMs } = workerData;
const signal = new Int32Array(flag);
let baton = null;
let base = url;

async function post(body, at = base, limitMs = timeoutMs - 3000) {
  const response = await fetch(at + '/v2/pipeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + authToken },
    body,
    signal: AbortSignal.timeout(limitMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error || text; } catch {}
    const error = new Error('Database request failed (' + response.status + '): ' + String(detail).slice(0, 300));
    error.status = response.status;
    throw error;
  }
  return JSON.parse(text);
}

async function handle(message) {
  const { id, requests, keep, retry } = message;
  const body = JSON.stringify({ baton, requests: keep ? requests : requests.concat([{ type: 'close' }]) });
  let data;
  try {
    try {
      data = await post(body);
    } catch (error) {
      const transient = !error.status || error.status >= 500;
      if (!retry || !transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      data = await post(body);
    }
  } catch (error) {
    // The caller treats the stream as gone after any failure, so forget it here too: a stale baton would send the
    // next request into a stream that no longer exists ("stream not found"), or into an unfinished transaction.
    // And close it on the server: closing a stream ends its unfinished transaction, which would otherwise hold the
    // write lock (and make every other instance wait) until the server gave up on it.
    const staleBaton = baton;
    const staleBase = base;
    baton = null; base = url;
    if (staleBaton) {
      try { await post(JSON.stringify({ baton: staleBaton, requests: [{ type: 'close' }] }), staleBase, 3000); } catch {}
    }
    return { id, ok: false, message: error && error.message ? error.message : String(error) };
  }
  let streamLost = false;
  if (keep) {
    baton = data.baton || null;
    if (data.base_url) base = data.base_url;
    streamLost = !baton;
  } else {
    baton = null;
    base = url;
  }
  return { id, ok: true, results: data.results, streamLost };
}

port.on('message', (message) => {
  handle(message).then((reply) => {
    port.postMessage(reply);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
});
`;

function normalizeUrl(raw) {
  const value = String(raw || '').trim();
  const match = /^(libsql|wss?|https?):\/\/(.+)$/i.exec(value);
  if (!match) throw new Error('TURSO_DATABASE_URL must look like libsql://your-database.turso.io');
  const scheme = match[1].toLowerCase() === 'http' ? 'http' : 'https';
  return `${scheme}://${match[2].replace(/\/+$/, '')}`;
}

function encodeValue(value) {
  if (value === null || value === undefined) return { type: 'null' };
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Cannot store a non-finite number');
      return Number.isSafeInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value };
    case 'bigint':
      return { type: 'integer', value: value.toString() };
    case 'boolean':
      return { type: 'integer', value: value ? '1' : '0' };
    case 'string':
      return { type: 'text', value };
    default:
      if (value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') };
      throw new TypeError(`Cannot store a ${typeof value} in the database`);
  }
}

function decodeValue(value) {
  switch (value && value.type) {
    case 'integer':
      return Number(value.value);
    case 'float':
      return Number(value.value);
    case 'text':
      return value.value;
    case 'blob':
      return Buffer.from(value.base64 || '', 'base64');
    default:
      return null;
  }
}

function databaseError(detail) {
  const error = new Error(detail?.message || 'Database error');
  if (detail?.code) error.code = detail.code;
  return error;
}

const isRead = (sql) => /^\s*(select\b|pragma\s+table_info\b)/i.test(sql);

function openRemoteDatabase({ url, authToken }) {
  const endpoint = normalizeUrl(url);
  const token = String(authToken || '');

  let worker = null;
  let port = null;
  let signal = null;
  let streamOpen = false;
  let foreignKeys = true;
  let depth = 0;
  let pending = [];
  let nextId = 1;

  function start() {
    const channel = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    signal = new Int32Array(flag);
    port = channel.port1;
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { port: channel.port2, flag, url: endpoint, authToken: token, timeoutMs: TIMEOUT_MS },
      transferList: [channel.port2],
    });
    worker.on('error', () => {});
    worker.unref();
    streamOpen = false;
  }

  function restart() {
    const old = worker;
    try {
      port.close();
    } catch {
      /* already closed */
    }
    old.terminate().catch(() => {});
    pending = [];
    start();
  }

  /** Send requests and block until the worker has the reply. */
  function call(requests, keep, retry) {
    const id = nextId++;
    Atomics.store(signal, 0, 0);
    port.postMessage({ id, requests, keep, retry });
    if (Atomics.wait(signal, 0, 0, TIMEOUT_MS) === 'timed-out') {
      restart();
      throw new Error('The database did not answer in time');
    }
    let reply;
    do {
      reply = receiveMessageOnPort(port)?.message;
    } while (reply && reply.id !== id);
    if (!reply) throw new Error('The database connection returned no answer');
    return reply;
  }

  /**
   * One round trip. Returns one raw result per request.
   *
   * A new stream needs foreign key checks switched on, but only for writing (they guard inserts, and deletes
   * that cascade). Reads skip it: on Turso that statement doubled the time of every query (about 50 ms more).
   */
  function exchange(requests, { keep = false, retry = false } = {}) {
    const first = !streamOpen;
    const writes = requests.some((r) => r.type === 'sequence' || (r.type === 'execute' && !isRead(r.stmt.sql)));
    const prelude = first && writes ? [execute(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`, [], false)] : [];
    const reply = call(prelude.concat(requests), keep, retry && first && !keep);
    if (!reply.ok) {
      streamOpen = false;
      throw new Error(reply.message);
    }
    if (reply.streamLost) {
      streamOpen = false;
      throw new Error('The database connection was reset in the middle of a transaction');
    }
    streamOpen = keep;
    // The setup statement is allowed to fail: it only asks for foreign key checks.
    return reply.results.slice(prelude.length, prelude.length + requests.length);
  }

  /** Positional values, or one object of named values (`@name`, `:name` or `$name` in the SQL). */
  function execute(sql, args = [], wantRows = true) {
    const stmt = { sql, want_rows: wantRows };
    const named = args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array);
    if (named) {
      stmt.named_args = Object.entries(args[0]).map(([name, value]) => {
        const prefix = /^[:@$]/.test(name) ? '' : (new RegExp(`([:@$])${name.replace(/\W/g, '')}\\b`).exec(sql)?.[1] || ':');
        return { name: prefix + name, value: encodeValue(value) };
      });
    } else {
      stmt.args = args.map(encodeValue);
    }
    return { type: 'execute', stmt };
  }
  const sequence = (sql) => ({ type: 'sequence', sql });

  function unwrap(result) {
    if (!result) throw new Error('The database sent an incomplete answer');
    if (result.type === 'error') throw databaseError(result.error);
    return result.response;
  }

  const rowsOf = ({ rows, cols }) => {
    const names = cols.map((c) => c.name);
    return rows.map((row) => Object.fromEntries(names.map((name, i) => [name, decodeValue(row[i])])));
  };

  function query(sql, args) {
    const queued = pending;
    pending = [];
    const results = exchange(queued.concat(execute(sql, args)), { keep: depth > 0, retry: depth === 0 && isRead(sql) });
    for (const result of results.slice(0, -1)) unwrap(result);
    const out = unwrap(results[results.length - 1]).result;
    const { affected_row_count: changes, last_insert_rowid: lastId } = out;
    return { rows: rowsOf(out), changes: Number(changes || 0), lastInsertRowid: lastId == null ? 0 : Number(lastId) };
  }

  function flush() {
    if (!pending.length) return;
    const queued = pending;
    pending = [];
    for (const result of exchange(queued, { keep: true })) unwrap(result);
  }

  const db = {
    remote: true,
    get: (sql, ...args) => query(sql, args).rows[0],
    all: (sql, ...args) => query(sql, args).rows,
    run: (sql, ...args) => {
      const { changes, lastInsertRowid } = query(sql, args);
      return { changes, lastInsertRowid };
    },
    insert: (sql, ...args) => query(sql, args).lastInsertRowid,
    prepare: (sql) => ({
      get: (...args) => db.get(sql, ...args),
      all: (...args) => db.all(sql, ...args),
      run: (...args) => db.run(sql, ...args),
    }),

    /**
     * Several queries in one round trip: [[sql, ...args], …] → the rows of each, in order. Every query is a round
     * trip to the hosted database (about 50 ms), so the independent reads of a page go together. Inside a
     * transaction they run in turn on its stream.
     */
    batch(queries) {
      if (!queries.length) return [];
      if (depth > 0) return queries.map(([sql, ...args]) => query(sql, args).rows);
      const results = exchange(queries.map(([sql, ...args]) => execute(sql, args)), { retry: queries.every(([sql]) => isRead(sql)) });
      return results.map((result) => rowsOf(unwrap(result).result));
    },

    /** Run one or more statements that return nothing. Inside a transaction they are sent with the next query. */
    exec(sql) {
      if (depth > 0) {
        pending.push(sequence(sql));
        return;
      }
      unwrap(exchange([sequence(sql)])[0]);
    },

    /** Run `fn` in a transaction; rolls back if it throws. Nested calls join the outer transaction. */
    transaction(fn, { foreignKeys: checkForeignKeys = true } = {}) {
      if (depth > 0) return fn();
      depth = 1;
      foreignKeys = checkForeignKeys;
      pending = [execute('BEGIN', [], false)];
      try {
        const result = fn();
        flush();
        unwrap(exchange([execute('COMMIT', [], false)])[0]);
        return result;
      } catch (error) {
        pending = [];
        if (streamOpen) {
          try {
            exchange([execute('ROLLBACK', [], false)]);
          } catch {
            /* the server already dropped the transaction */
          }
        }
        throw error;
      } finally {
        depth = 0;
        foreignKeys = true;
      }
    },

    close() {
      try {
        port.close();
      } catch {
        /* already closed */
      }
      worker.terminate().catch(() => {});
    },
  };

  start();
  addIntrospection(db);
  // Fail early, with a readable message, if the address or token is wrong.
  try {
    db.get('SELECT 1 AS ok');
  } catch (error) {
    db.close();
    throw new Error(`Could not connect to the database at ${endpoint}: ${error.message}`);
  }
  return db;
}

module.exports = { openRemoteDatabase, normalizeUrl };
