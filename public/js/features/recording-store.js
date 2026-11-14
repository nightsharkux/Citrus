/**
 * Recordings kept on this phone while they are made: every second of audio goes into the browser's storage
 * (IndexedDB), so closing the app, a crash or a lost connection never loses a recording. A recording stays here
 * until it was uploaded or the user deletes it; it can always be saved to the phone as a file.
 *
 * Without IndexedDB (some private windows) everything still works, only without this safety net.
 */
const NAME = 'campus-recordings';
let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('takes', { keyPath: 'id' });
        db.createObjectStore('chunks', { autoIncrement: true }).createIndex('take', 'take');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

const done = (tx) => new Promise((resolve) => {
  tx.oncomplete = () => resolve(true);
  tx.onerror = () => resolve(false);
  tx.onabort = () => resolve(false);
});
const result = (req) => new Promise((resolve) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => resolve(null);
});

/** Start keeping a recording. Returns its id, or null when this browser cannot keep it. */
export async function beginTake({ workspaceId, title, mime }) {
  const db = await open();
  if (!db) return null;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tx = db.transaction('takes', 'readwrite');
  tx.objectStore('takes').put({ id, workspaceId, title, mime, started: new Date().toISOString(), seconds: 0, bytes: 0 });
  return (await done(tx)) ? id : null;
}

/** One more piece of audio (the recorder gives one per second). */
export async function addChunk(id, blob, seconds) {
  const db = await open();
  if (!db || !id) return;
  const tx = db.transaction(['takes', 'chunks'], 'readwrite');
  tx.objectStore('chunks').add({ take: id, blob });
  const takes = tx.objectStore('takes');
  const take = await result(takes.get(id));
  if (take) takes.put({ ...take, seconds, bytes: take.bytes + blob.size });
  await done(tx);
}

/** The whole recording as one file. */
export async function takeBlob(id) {
  const db = await open();
  if (!db) return null;
  const tx = db.transaction(['takes', 'chunks'], 'readonly');
  const take = await result(tx.objectStore('takes').get(id));
  const pieces = await result(tx.objectStore('chunks').index('take').getAll(id));
  if (!take || !pieces?.length) return null;
  return new Blob(pieces.map((p) => p.blob), { type: (take.mime || 'audio/webm').split(';')[0] });
}

export async function dropTake(id) {
  const db = await open();
  if (!db || !id) return;
  const tx = db.transaction(['takes', 'chunks'], 'readwrite');
  tx.objectStore('takes').delete(id);
  const keys = await result(tx.objectStore('chunks').index('take').getAllKeys(id));
  for (const key of keys || []) tx.objectStore('chunks').delete(key);
  await done(tx);
}

/** Recordings kept on this phone for a space, newest first. */
export async function takesFor(workspaceId) {
  const db = await open();
  if (!db) return [];
  const all = await result(db.transaction('takes', 'readonly').objectStore('takes').getAll());
  return (all || []).filter((t) => t.workspaceId === workspaceId && t.bytes > 0).sort((a, b) => b.started.localeCompare(a.started));
}

/** A file name for a recording. */
export const takeName = (take) => {
  const ext = /mp4|aac|m4a/.test(take.mime || '') ? 'm4a' : /ogg/.test(take.mime || '') ? 'ogg' : 'webm';
  return `${String(take.title || 'recording').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 60)}-${take.started.slice(0, 16).replace(/[T:]/g, '-')}.${ext}`;
};
