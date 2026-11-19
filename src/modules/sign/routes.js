'use strict';
/**
 * The study sign: a "please do not disturb" screen a student shows while studying. The sign itself lives in the browser
 * (public/js/pages/sign.js, kept on the device); the one thing the server does is design one from a description.
 *
 *   POST /api/sign/design   { prompt }   → { design }   Citrus designs a sign: colours, message, style (signed-in users)
 *
 * The reply of the model is untrusted: design.js reads it as a small JSON object and lets only known values through, so
 * a design can never carry markup, script or a colour nobody can read.
 */
const { text } = require('../../lib/validate');
const { unavailable, tooMany } = require('../../http/errors');
const { createRateLimiter } = require('../../http/rate-limit');
const { signDesignPrompt } = require('../../ai/prompts');
const { sanitizeDesign } = require('./design');

function register(router, { ai }) {
  const designing = createRateLimiter({ windowMs: 60_000, max: 8 });

  router.post('/api/sign/design', async (ctx) => {
    const user = ctx.user;
    const b = await ctx.json(4_000);
    const prompt = text(b.prompt, { min: 3, max: 300, label: 'Description' });
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    if (!designing.hit(user.id)) throw tooMany('Citrus is still designing. Wait a minute and try again.');
    const reply = await ai.complete({ user, system: signDesignPrompt(), prompt: `<REQUEST>\n${prompt}\n</REQUEST>`, maxTokens: 300, task: 'summary' });
    const design = sanitizeDesign(reply);
    if (!design) throw unavailable('Citrus could not design that this time. Try describing it differently.');
    return { design };
  });
}

module.exports = { register };
