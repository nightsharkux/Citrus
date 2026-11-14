'use strict';
/**
 * Speech in a short audio file → lines of text with their times. Used when the Campus OS Android app records in the
 * background (screen off, app closed): it sends the lecture or meeting audio in pieces of about a minute, and only
 * the text is kept. The audio is never stored.
 */
const { badRequest, unavailable } = require('../../http/errors');
const { transcribePrompt } = require('../../ai/prompts');

const AUDIO = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/3gpp': '3gp' };
const MAX_BYTES = 6 * 1024 * 1024;

/** The audio piece of a request: its bytes, type, when it started and how long it is. */
async function readAudio(ctx) {
  const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO[mime]) throw badRequest('Send the audio as m4a, aac, mp3, webm, ogg or wav');
  const buffer = await ctx.raw(MAX_BYTES);
  if (buffer.length < 200) throw badRequest('The audio is empty');
  const durationMs = Math.min(10 * 60_000, Math.max(1000, Number(ctx.req.headers['x-duration-ms']) || 60_000));
  const said = Date.parse(String(ctx.req.headers['x-recorded-at'] || ''));
  const startedAt = Number.isFinite(said) && said <= Date.now() + 5000 ? said : Date.now() - durationMs;
  return { buffer, mime, startedAt, durationMs };
}

/** The lines spoken in the audio, in order. Empty when nobody spoke. */
async function transcribe({ ai, user, buffer, mime, language }) {
  if (!ai.status(user).aiEnabled) throw unavailable('Transcription needs the AI, which is not connected yet.');
  const raw = await ai.complete({
    user,
    system: transcribePrompt(language),
    prompt: { text: 'Transcribe the attached audio.', files: [{ data: buffer.toString('base64'), mime, name: `audio.${AUDIO[mime]}` }] },
    maxTokens: 3000,
    task: 'search',
  });
  return String(raw || '')
    .replace(/\[(no speech|silence|inaudible|music)\]/gi, '')
    .split(/\n+|(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9„"])/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .slice(0, 400);
}

/** Times for the lines, spread over the piece in proportion to their length. */
function spread(lines, startedAt, durationMs) {
  const total = lines.reduce((n, l) => n + l.length, 0) || 1;
  let at = startedAt;
  return lines.map((text) => {
    const line = { text: text.slice(0, 600), created: new Date(Math.round(at)).toISOString() };
    at += (durationMs * text.length) / total;
    return line;
  });
}

module.exports = { readAudio, transcribe, spread, AUDIO };
