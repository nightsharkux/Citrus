# AI integration

All AI goes through one service (`src/ai/service.js`), so provider choice, quotas and data boundaries are applied in one place.

```js
const { ai } = deps;
ai.status(user)                                   // { provider, label, aiEnabled, model, location, description }
await ai.complete({ user, system, prompt, history, maxTokens, task })    // → string
for await (const text of ai.stream({ user, system, prompt, history, signal })) { … }
ai.retrieve(user, query, limit)                   // → numbered sources for citations
```

Every call is attributed to a user. Their institution's provider setting is applied, and so is a per-user rate limit (`CAMPUS_AI_RATE_PER_MINUTE`). Provider errors surface as `503 { error }` with a readable message.

## Files

| File | What it is |
|---|---|
| `src/ai/providers/index.js` | The registry and generic driver (timeouts, errors, streaming, history trimming) |
| `src/ai/providers/{ollama,gateway,openai,anthropic}.js` | One small adapter per provider |
| `src/ai/providers/stream.js` | NDJSON and SSE readers for `fetch` bodies |
| `src/ai/prompts.js` | **Every system prompt**: tone, safety, teaching modes |
| `src/ai/retrieval.js` | Knowledge search (BM25) and the source shape used for citations |
| `src/ai/context.js` | The user's own data for the personal assistant (courses, schedule, difficulties, review) |
| `src/ai/service.js` | Provider selection per institution, quota, `complete`, `stream`, `retrieve` |
| `src/ai/visuals.js` | Parses the optional `[visual: …]` cue at the start of an answer (see below) |

## Vercel AI Gateway setup

Campus OS calls the [OpenAI-compatible gateway API](https://vercel.com/docs/ai-gateway/openai-compat) with Node's built-in `fetch`. There is no SDK dependency and the app can run outside Vercel.

1. Create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok/authentication) in the Vercel dashboard. Configure gateway credits and a per-key spending budget there; the app's per-user rate limit is not a spending cap.
2. Set these variables in the server's private `.env`:

   ```dotenv
   AI_GATEWAY_API_KEY=<your gateway API key>
   CAMPUS_AI_PROVIDER=gateway
   CAMPUS_GATEWAY_MODEL=openai/gpt-6-luna
   CAMPUS_GATEWAY_SUMMARY_MODEL=google/gemini-2.5-flash-lite
   CAMPUS_TRANSCRIPTION_PROVIDER=off
   ```

3. Restart with `npm start`. In **Admin → AI & knowledge**, select **Vercel AI Gateway**, save and use **Test connection**. The institution's saved provider takes precedence over `CAMPUS_AI_PROVIDER`.
4. Import approved knowledge sources, then check citations, teaching answers and practice questions against your own examples. A successful connection test checks connectivity, not answer quality. `npm run check -- --ai` also makes one live chat-model request per institution; ordinary `npm run check` makes none.

### Cost-conscious task routing

| Task | Default model | Environment override |
|---|---|---|
| Personal/workspace chat, tutoring, practice questions, classroom text answers and connection tests | `openai/gpt-6-luna` | `CAMPUS_GATEWAY_MODEL` |
| Meeting minutes, live-caption summaries and feedback themes | `google/gemini-2.5-flash-lite` | `CAMPUS_GATEWAY_SUMMARY_MODEL` |

Feature modules mark summarization calls with the server-controlled `task: 'summary'`; other calls use the chat model. This metadata affects only Gateway. Existing Ollama, direct OpenAI and Anthropic routing is unchanged. The chosen chat model and summary model are shown in Admin. Clients cannot select arbitrary models or tasks.

The [gateway catalog](https://ai-gateway.vercel.sh/v1/models), checked November 8, 2026, lists Luna at $0.10 input / $0.50 output and Flash-Lite at $0.10 / $0.40 per million text tokens at standard global rates. At 3,000 input and 500 output tokens, 1,000 requests would cost about $0.55 and $0.50 respectively, excluding cache writes, regional premiums and other charges. These are estimates, not measured application bills; prices and actual context sizes vary.

The adapter disables thinking for these two default models, preserves each feature's output limit, and asks the gateway to sort providers by cost for the selected model. Other model overrides use that model's default reasoning behavior. No fallback model or automatic premium-model escalation is configured. Evaluate a more capable chat model only if real examples show Luna falling short. Gateway may route the same model among its available providers; configure any required provider/data restrictions in Vercel.

The gateway key stays on the server. It does not enable cloud audio transcription or trigger local-to-cloud fallback. Gateway and downstream provider data policies apply to prompts sent through this cloud option.

## Adding a provider

Create `src/ai/providers/<name>.js`:

```js
module.exports = {
  id: 'mistral', label: 'Cloud · Mistral', location: 'cloud', timeoutMs: 60_000,
  model: (env) => env.CAMPUS_MISTRAL_MODEL || 'mistral-large-latest',
  missing: (env) => (env.MISTRAL_API_KEY ? null : 'MISTRAL_API_KEY is missing on the server'),
  describe: () => 'Cloud AI selected (Mistral).',
  request({ env, model, system, messages, stream, maxTokens }) {
    return { url: 'https://api.mistral.ai/v1/chat/completions',
             headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
             body: { model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens, stream } };
  },
  parse: (json) => json?.choices?.[0]?.message?.content,
  async *parseStream(response) { /* see openai.js — same SSE format */ },
  errors: { unreachable: 'Cannot reach Mistral.', status: (c) => `Mistral returned HTTP ${c}.` },
};
```

Then add it to `PROVIDERS` in `providers/index.js`. It appears in Admin → AI & knowledge automatically. No schema change is needed.

## Changing behaviour

- **Tone and safety:** edit `STYLE`, `SAFETY` and `GUIDANCE` in `prompts.js`. Each prompt builder there is a plain function.
- **What the assistant knows about the user:** add a function to `SECTIONS` in `context.js`. Each one returns a short string. Only ever read the signed-in user's own data.
- **What it can cite:** the knowledge library, curated by admins (Admin → AI & knowledge), with JSONL, Markdown or text import. Records carry `source_url` and `volatility`, and anything not marked `stable` makes the answer tell the user to check the live source.
- **Better retrieval:** replace `search()` in `retrieval.js` with an embedding index. Callers only rely on `toSource()`'s shape, `{ n, id, title, excerpt, url, checkLive }`.

## Data boundaries (keep these)

- Untrusted text (notes, transcripts, knowledge) sits in delimited blocks, and the prompt tells the model never to follow instructions inside them.
- The personal assistant sees only the signed-in user's data. Workspace assistants see that workspace's notes and the institution's approved knowledge.
- Keys stay on the server and are never sent to the browser.
- Local (Ollama) never falls back to the cloud silently.
- Meeting transcription is a separate opt-in (`CAMPUS_TRANSCRIPTION_PROVIDER`).

## Where AI is used

| Feature | Module | Prompt |
|---|---|---|
| Personal assistant (streamed, cited) | `modules/assistant` | `assistantPrompt` |
| Space assistant (teaching modes) | `modules/workspaces` | `workspacePrompt` |
| Meeting minutes | `modules/workspaces` (`/analyze`) | `meetingPrompt`. Falls back to a labelled text extractor when AI is off |
| Live-caption summary | `modules/workspaces` | `captionsSummaryPrompt` |
| Practice sets | `modules/study` | `revisionPrompt`. Validated JSON; falls back to the lecturer's own checks |
| Feedback themes | `modules/admin` | `suggestionsPrompt` |
| Voice puck answers | `modules/devices` | `voicePrompt` |

## Campus's face and illustrations

The assistant is called **Campus** (`site.assistant` in `config/editions/*.js`). Its face is the ring from the logo, used as a robot eye (`public/js/features/face.js`). There is no pupil: the ring itself is the eye. It squashes flat to blink, slides and turns to look around, follows the pointer, follows the caret while someone types and looks back up when they stop. Every expression is a change in the ring's own shape, drawn as one SVG path each frame and moved with springs:

| Mood | The ring… |
|---|---|
| `idle` | breathes, blinks, glances around, now and then tilts curiously, squints or hops; drowsy (heavy lid) after a minute without activity |
| `listening` | opens wide and pulses |
| `thinking` | looks up to the side while a gap circles the ring |
| `speaking` | squashes in a talking rhythm |
| `happy` | becomes an upturned arc and hops |
| `surprised` | pops open, wide and thin |
| `confused` | tilts and wobbles with a slanted lid |
| `sad` | shrinks, droops and loses some colour (used when a request fails) |
| `asleep` | closes to a downturned arc (no model connected) |

Shapes live in `MOODS` in `face.js` (width, upper and lower height, slant, tilt, gap), so a new expression is one line.

```js
import { createFace, faceGroup, watchTyping } from '/js/features/face.js';
const face = createFace({ size: 64 });            // face.el is the element to insert
face.setMood('thinking');  face.react('happy', 1500);
face.showVisual({ kind: 'formula', content: 'a^2 + b^2 = c^2' });  face.hideVisual();
const stop = watchTyping(textarea, face);          // eyes follow the caret
face.destroy(); stop();
```

**Illustrations.** While Campus explains something, the eye can turn into a small animation. The model asks for one by starting its answer with a single line:

```text
[visual: formula | a^2 + b^2 = c^2]

The Pythagorean theorem links …
```

The instruction is `VISUAL_CUES` in `prompts.js`. `src/ai/visuals.js` removes the line from the text (in any chunking while streaming), sends it as an SSE `visual` event `{ kind, content }`, includes it in `done` and stores it in `assistant_messages.visual` so it can be replayed later. A malformed cue stays in the text as-is. Kinds: `formula`, `numbers`, `chart`, `sort`, `steps`, `people`, `cycle`, `clock`, `code`, `idea`, `trend`, plus a few aliases (`equation`, `team`, `process`, …).

Small models often skip the cue. If no cue arrives, the front end makes a cautious guess from the question and answer (`inferVisual` in `public/js/features/face-visuals.js`), but only for explanatory questions. Users can switch illustrations off in Settings → Assistant (`preferences.visuals`).

**Adding a kind:** add the name to `KINDS` in `src/ai/visuals.js`, describe it in `VISUAL_CUES`, and add an entry to `VISUALS` in `face-visuals.js` with `label(content)`, `draw(content)` returning SVG markup in a 100×100 box centred on 0,0, and an optional `start(layer)` that animates it and returns a stop function. Keep it to a few shapes, use the `fv-*` classes in `public/css/face.css` for colour, and give it a still final frame for reduced motion.

## Voice

The browser handles voice (`public/js/features/voice.js`):

- `wake`: the app-wide wake word. When a user turns on *Listen for "Hey Campus"*, it listens on every page for "Hey Campus, …" or "Campus, …" (also "hi", "hallo", "ok"). The words after the name are the command. Hearing the name alone arms it for 8 seconds, so the next sentence counts. The open page can handle commands with `wake.onCommand(fn)`. Otherwise the shell opens the assistant. Dictation pauses it automatically.
- `dictate`, `speak`/`stopSpeaking` (read-aloud) and `createCaptioner` (live captions in spaces).
- `voiceProblem()` explains why voice is unavailable: unsupported browser, or a page not served over HTTPS or localhost.

To use an on-device engine (Whisper.cpp, Vosk) instead, replace `Recognition` in that file. Hardware pucks do their own speech-to-text and send text as `voice.query` events (see [HARDWARE.md](HARDWARE.md)).
