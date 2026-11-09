'use strict';
/**
 * Natural voices: Campus's answers read aloud by the AI Gateway's speech models (public/js/features/speaker.js).
 *
 *   GET  /api/speech   { enabled, model?, voices: [{ id, label, tone, language? }], default }
 *   POST /api/speech   { text, voice?, speed?, lang? } → the audio itself (audio/mpeg or audio/wav)
 *
 * The browser asks for one or a few sentences at a time while the answer is still being written, and plays them
 * back to back. When natural voices are off or unavailable this answers 503 and the browser uses its own voices.
 */
const { text, oneOf } = require('../../lib/validate');
const { badRequest } = require('../../http/errors');

function register(router, { ai }) {
  router.get('/api/speech', (ctx) => ai.speechInfo(ctx.user));

  router.post('/api/speech/recognition-session', async (ctx) => {
    const b = await ctx.json();
    const language = oneOf(b.language || 'multi', ['multi', 'en', 'de'], 'Language');
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.res.on('close', abort);
    ctx.res.setHeader('Cache-Control', 'no-store');
    try { return await ai.recognitionSession({ user: ctx.user, language, signal: controller.signal }); }
    finally { ctx.res.off('close', abort); }
  });

  router.post('/api/speech', async (ctx) => {
    const b = await ctx.json();
    const said = text(b.text, { min: 1, max: 1200, label: 'Text' });
    const voice = b.voice === undefined || b.voice === null || b.voice === '' ? '' : text(b.voice, { max: 60, label: 'Voice' });
    const speed = b.speed === undefined || b.speed === null ? 1 : Number(b.speed);
    if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.6) throw badRequest('Speed must be between 0.6 and 1.6');
    const language = b.lang ? oneOf(b.lang, ['en', 'de'], 'Language') : null;

    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.res.on('close', abort);
    try {
      const { audio, mime } = await ai.speak({ user: ctx.user, text: said, voice, speed: Math.round(speed * 100) / 100, language, signal: controller.signal });
      ctx.res.writeHead(200, { 'Content-Type': mime, 'Content-Length': audio.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      ctx.res.end(audio);
    } finally {
      ctx.res.off('close', abort);
    }
  });
}

module.exports = { register };
