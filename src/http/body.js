'use strict';
const { badRequest, tooLarge } = require('./errors');

/** Read the raw request body, enforcing a size limit. */
function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(tooLarge(`Request exceeds ${Math.round(maxBytes / 1024)} KB`));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body. An empty body becomes `{}`. */
async function readJson(req, maxBytes = 100_000) {
  const raw = await readRaw(req, maxBytes);
  if (!raw.length) return {};
  try {
    const value = JSON.parse(raw.toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw badRequest('Invalid JSON');
  }
}

module.exports = { readRaw, readJson };
