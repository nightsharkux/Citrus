# AI integration

All AI goes through one service (`src/ai/service.js`), so gateway configuration, quotas and data boundaries are applied in one place.

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
| `src/ai/providers/index.js` | Gateway transport (timeouts, errors, streaming, history trimming) |
| `src/ai/providers/gateway.js` | The Vercel AI Gateway adapter and response parser |
| `src/ai/providers/stream.js` | SSE readers for `fetch` bodies |
| `src/ai/prompts.js` | **Every system prompt**: tone, safety, teaching modes |
| `src/ai/retrieval.js` | Knowledge search (BM25) and the source shape used for citations |
| `src/ai/context.js` | The user's own data for the personal assistant (courses, schedule, difficulties, review) |
| `src/ai/service.js` | Provider selection per institution, quota, `complete`, `stream`, `retrieve` |
| `src/ai/visuals.js` | Parses the optional `[visual: …]` cue at the start of an answer (see below) |
| `src/ai/actions.js` | Finds the `[action: …]` lines at the start of an answer, in any chunking (see *Actions*) |
| `src/modules/assistant/actions.js` | The actions themselves: what they may touch, how they are validated, how they are undone |

## Vercel AI Gateway setup

Campus OS calls the [OpenAI-compatible gateway API](https://vercel.com/docs/ai-gateway/openai-compat) with Node's built-in `fetch`. There is no SDK dependency and the app can run outside Vercel.

1. Create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok/authentication) in the Vercel dashboard. Configure gateway credits and a per-key spending budget there; the app's per-user rate limit is not a spending cap.
2. Set these variables in the server's private `.env`:

   ```dotenv
   AI_GATEWAY_API_KEY=<your gateway API key>
   CAMPUS_AI_PROVIDER=gateway
   CAMPUS_AI_DEFAULT_MODEL=openai/gpt-6.1-terra/medium
   CAMPUS_AI_SUMMARY_MODEL=openai/gpt-6-luna/low
   ```

3. Restart with `npm start`. In **Admin → AI & knowledge**, select **Vercel AI Gateway**, save and use **Test connection**. The institution's saved Gateway/Off choice takes precedence over `CAMPUS_AI_PROVIDER`. With no saved choice, Gateway is the default; a missing key leaves it inactive.
4. Import approved knowledge sources, then check citations, teaching answers and practice questions against your own examples. A successful connection test checks connectivity, not answer quality. `npm run check -- --ai` also makes one live default-model request per institution; ordinary `npm run check` makes none.

### Cost-conscious task routing

| Task | Default model | Environment override |
|---|---|---|
| Personal/workspace chat, tutoring, practice questions, classroom text answers and connection tests | `openai/gpt-6.1-terra/medium` | `CAMPUS_AI_DEFAULT_MODEL` |
| Meeting minutes, live-caption summaries and feedback themes | `openai/gpt-6-luna/low` | `CAMPUS_AI_SUMMARY_MODEL` |

Feature modules mark summarization calls with the server-controlled `task: 'summary'`; other calls use the default model. Vercel AI Gateway is the only AI connection. Off disables model calls. The chosen default model and summary model are shown in Admin. Clients cannot select arbitrary models or tasks.

The [gateway catalog](https://ai-gateway.vercel.sh/v1/models), checked November 8, 2026, lists GPT-6.1 Terra at $1.00 input / $5.00 output and GPT-6 Luna at $0.10 / $0.50 per million text tokens at standard global rates for contexts below 272,001 tokens. At 3,000 input and 500 output tokens, 1,000 requests would cost about $5.50 and $0.55 respectively, excluding cache writes, regional premiums and other charges. These are estimates, not measured application bills; prices and actual context sizes vary.

Model settings accept `provider/model/reasoning`: the default uses medium reasoning and summaries use low. The adapter removes the final segment from the model ID and sends it as `reasoning.effort` to the [gateway reasoning API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning). No separate reasoning environment variable is needed.

Omit the segment to use the model's own default, or use `/none` to disable reasoning where supported. Gateway effort names are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; only use a level supported by the selected model. The gateway validates model-specific support and translates the setting to the serving provider's controls. Malformed slugs and unknown effort names disable AI configuration before a request is sent.

The adapter preserves each feature's output token limit and asks the gateway to sort providers by cost for the selected model. Reasoning tokens can consume the output budget and are billable; the price examples above exclude additional reasoning tokens. No fallback model or automatic premium-model escalation is configured. Evaluate Terra against real teaching examples before relying on answer quality. Gateway may route the same model among its available providers; configure any required provider/data restrictions in Vercel.

Terra supports the current text Chat Completions requests. Future tool calling with Terra requires the Responses API.

The gateway key stays on the server. Uploaded audio is never sent to a provider. Automatic transcription is in development; recordings can have a typed transcript and meetings can use browser live captions. Gateway and downstream provider data policies apply to prompts sent through this cloud option.

## Configuration and upgrades

Model settings use role-based names: `CAMPUS_AI_DEFAULT_MODEL` for the default model and `CAMPUS_AI_SUMMARY_MODEL` for summaries. Replace the earlier model variable names in your hosting settings, then redeploy.

The AI settings are `AI_GATEWAY_API_KEY`, `CAMPUS_AI_DEFAULT_MODEL`, `CAMPUS_AI_SUMMARY_MODEL`, `CAMPUS_AI_PROVIDER` (`gateway` or `off`) and `CAMPUS_AI_RATE_PER_MINUTE`. Only the key is required to configure the gateway; the other values have defaults. The key stays in the server environment. Do not expose it through a browser variable or commit `.env`.

Retired direct-provider and local-provider environment variables are ignored and can be removed. Saved institution choices for a retired provider resolve to Off until an administrator explicitly selects Gateway. Existing conversations and knowledge stay intact; no database migration is required.

Gateway access is separate from website hosting. See [DEPLOYMENT.md](DEPLOYMENT.md#vercel-hosting-and-environment-variables) before importing this app into Vercel: the current backend needs persistent disk storage.

## Changing behaviour

- **Tone and safety:** edit `STYLE`, `SAFETY` and `GUIDANCE` in `prompts.js`. Each prompt builder there is a plain function.
- **What the assistant knows about the user:** add a function to `SECTIONS` in `context.js`. Each one returns a short string. Only ever read the signed-in user's own data.
- **What it can cite:** the knowledge library, curated by admins (Admin → AI & knowledge), with JSONL, Markdown or text import. Records carry `source_url` and `volatility`, and anything not marked `stable` makes the answer tell the user to check the live source.
- **Better retrieval:** replace `search()` in `retrieval.js` with an embedding index. Callers only rely on `toSource()`'s shape, `{ n, id, title, excerpt, url, checkLive }`.

## Data boundaries (keep these)

- Untrusted text (notes, transcripts, knowledge) sits in delimited blocks, and the prompt tells the model never to follow instructions inside them.
- The personal assistant sees only the signed-in user's data. Workspace assistants see that workspace's notes and the institution's approved knowledge.
- Keys stay on the server and are never sent to the browser.
- Off and retired provider selections never trigger gateway requests.
- Uploaded meeting audio stays on the app server; automatic transcription is in development.

## Where AI is used

| Feature | Module | Prompt |
|---|---|---|
| Personal assistant (streamed, cited, with pictures and documents) | `modules/assistant` | `assistantPrompt` |
| Voice conversation (`mode: 'voice'`) | `modules/assistant` | `assistantPrompt` with `VOICE_GUIDE` instead of `FORMAT_GUIDE` |
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

## Formatting and maths

The assistant writes Markdown and LaTeX (`FORMAT_GUIDE` in `prompts.js`): formulas between `$…$` or on their own lines between `$$…$$`, numbered working, definition lists, tables and "> **Key idea:**" callouts. The browser draws them with no library: `public/js/core/markdown.js` handles the Markdown and `public/js/core/math.js` converts LaTeX to MathML, which every current browser renders natively with the system's maths font (Cambria Math, STIX Two Math, Latin Modern Math). Fractions stack, roots get a real radical, exponents sit where they belong. Supported: fractions, roots, scripts, Greek, relations and arrows, sums, integrals and limits, matrices, `cases`, `aligned`, accents, `\left…\right` and `\text`. An unknown command is shown as written instead of breaking the answer, and all text is escaped. Read-aloud turns formulas into words ("x squared plus 3") through `speakable()`.

## Conversation and attachments

`CONVERSATION` in `prompts.js` sets how the assistant talks: short natural replies to small talk, structure only for real explanations, memory of the whole thread (the last 24 messages go to the model), one clarifying question only when a request is truly ambiguous, and general help beyond university topics. `ATTACHMENT_GUIDE` is added when the thread has files.

**What it already knows** (`src/ai/context.js`, built for every message from the user's own data only): the time and dates, role and programme, what is on right now and what comes next, enrolled courses with lecturer and next session, exams and deadlines for the next 60 days (a separate section so a busy week cannot push them out), the next 14 days of schedule, free time in the coming three days, topics the student marked as not understood, review items due, key points from recent lectures, spaces, unread notifications and recent conversation titles. Lecturers get how recent topics landed, as counts. `CONTEXT_GUIDE` tells the model to use all this instead of asking, to resolve "my exam" or "tonight" itself, and to say so when something is not in Campus OS. Assignments exist only as `deadline` and `exam` events in the schedule; there is no separate gradebook, and the assistant is told not to guess. `GET /api/assistant` also returns `starters`, conversation openers built from the user's next exam, class or hard topic.

Pictures and documents (`modules/assistant/attachments.js`, UI in `public/js/features/attach.js`): the browser uploads each file as soon as it is added (button, paste or drop) to `POST /api/assistant/attachments` as base64 JSON, then sends the message with `attachments: [ids]`. Pictures are shrunk in the browser (longest side 1600 px, JPEG), checked by their bytes on the server and kept so follow-up questions can still look at them. They go to the model as `image_url` parts, so the selected model must accept images. Documents are read to text once on upload by `src/lib/extract-text.js` (text, Markdown, CSV, JSON, code, HTML, DOCX, PPTX, XLSX and text-based PDFs, with Node built-ins only) and reach the model as `ATTACHMENT` reference blocks, which the safety rules treat as untrusted. A scanned PDF has no text; the user is told to attach photos of the pages. Limits: 3 MB per file (Vercel caps request bodies at 4.5 MB), 6 files per message, 60,000 characters kept per document, the newest 4 pictures per request. Unsent uploads are removed after a day.

## Actions

Campus can change things for the signed-in user, hands-free. The text-only chat API has no tool calling, so the model starts its answer with one line per action:

```text
[action: calendar.add | {"title":"Study session","start":"2026-11-10T16:00","duration_minutes":90}]

Adding a study session for tomorrow at 4 pm.
```

`src/ai/actions.js` removes these lines from the text (only at the very start, so nothing in the middle of an answer is ever run) and calls `src/modules/assistant/actions.js` as soon as each is complete, while the prose is still streaming. Each result is sent as an SSE `action` event, repeated in `done`, and stored in `assistant_messages.actions`. The page shows it as a card with *View* and *Undo*.

| Action | What it does |
|---|---|
| `calendar.add` / `calendar.update` / `calendar.delete` | The user's **own** personal events. Times are local (`YYYY-MM-DDTHH:mm`) in the institution's time zone. Overlaps are reported. Recurring events can change title or place, not time. |
| `app.navigate` | Opens a page (limited to the pages the user's role has) or one of their courses. Carried out by the browser. |
| `app.theme` | Light, dark or system. Carried out by the browser. |

Safety rules, all enforced on the server:

- Actions run as the user through the same rules as the rest of the app, scoped to `user.institution_id`. Course and university-wide events, other people's events, posting and messaging are out of reach.
- Every change except navigation is audited (`assistant_action`) and can be undone once (`POST /api/assistant/messages/:id/actions/:index/undo`). The undo data never leaves the server.
- Text in notes, knowledge sources and transcripts cannot trigger actions: the prompt says so, and only the answer's leading lines are parsed. At most six actions run per answer.
- The model sees the schedule for 14 days with an `[id N]` on events it may change, plus a table of dates, and its own earlier actions in the history, so "move it an hour later" works.

**Adding an action:** add a function to `ACTIONS` in `src/modules/assistant/actions.js` returning `{ title, detail?, warning?, link?, client?, undo? }`, describe it in `ACTION_GUIDE` in `prompts.js`, and add a test with an access-denied case.

## What it knows about the university

The assistant answers university questions from four sources, all read directly from files in `resources/` (nothing to import):

| Source | File | Made by | What it holds |
|---|---|---|---|
| Curated facts | `OTH_Public_Knowledge_*.jsonl` | by hand | identity, faculties, key services (can also be imported into the database from Admin → AI & knowledge) |
| The university website | `OTH_Website_Knowledge.jsonl` | `node scripts/crawl-oth.js` | about 3,000 passages from the public pages in German and English: programmes, services, procedures, contacts (names, e-mail, phone, rooms, office hours as printed) |
| Timetable and exam documents | `OTH_Timetable_Documents.jsonl` | `python scripts/oth-timetables.py` | the text of the published exam plans, lecture-hall allocation and notes |
| Class timetables | `oth-timetables.json` | `python scripts/oth-timetables.py` | every programme's weekly pattern as data: weekday, start, end, course, room, lecturer |

- **Retrieval** (`src/ai/retrieval.js`, `src/lib/search.js`) searches these together with the entries an administrator adds. It matches English questions to German pages through a synonym list (contact/Kontakt, timetable/Stundenplan, canteen/Mensa, mentor/Mentoring...), forgives spelling slips ("Banhof" finds Bahnhof) and finds German compounds from their parts. The six best passages go to the model with their source links. Set `CAMPUS_BUNDLED_KNOWLEDGE=off` to leave the packs out (the tests do).
- **"What do I have right now?"** The class timetables are not searched, they are computed (`src/ai/programme-timetables.js`). The programme comes from the profile or from the conversation ("I'm in DTM", "Digital Technology and Management, 3rd semester"), and `CONTEXT` then lists what runs now, what comes later today and the week, with room and lecturer. With no semester known, every semester that has something on is listed and the assistant asks only when that changes the answer. A programme that publishes its timetable only as a picture is linked instead.
- **Refreshing.** Run the two scripts again when the university publishes a new semester or changes pages, review the diff, commit. They read only public pages, one request at a time, follow `robots.txt`, and skip the staff directory (`/hochschule/ueber-uns/personen/`), which the university asks AI crawlers to leave alone. `storage/oth-crawl/` caches the raw pages and is git-ignored. `scripts/oth-timetables.py` needs `pip install pymupdf`; the app itself does not.
- Everything copied from the website is public information with the source link and the date it was read shown with each answer. Confirm anything that matters on the live page.

## Languages

People here use German and English together, often in one sentence. `LANGUAGE_GUIDE` in `src/ai/prompts.js` tells the model that this is normal: mixed sentences, German words and place names inside English ("Banhof", "Schirmitzer Weg"), missing umlauts, broken grammar and speech-recognition errors in both languages. It answers in the language of the latest message, keeps official German terms with a short gloss and understands German dates ("halb drei", "übermorgen"). The same guide is in the classroom voice and workspace prompts.

- **Interface.** `public/js/core/i18n.js` translates what is on screen from the dictionary in `i18n-de*.js` (text, placeholders, labels, toasts) and follows each person's language setting, then the browser. Add a string by adding its English text and the German beside it. Text people wrote is never touched. Not everything is translated: the feature catalogue (`config/capabilities.js`) and the career questions are English only.
- **Voice.** Speech recognition can listen for one language at a time. *Voice input language* is Automatic (follow the language you spoke last), English or Deutsch; "auf Deutsch" and "in English" switch it by voice. Answers are read piece by piece in the language they are written in, with a voice chosen per language (Settings → Assistant → Voice). `detectLanguage` in `features/turns.js` tells the two apart by common words and umlauts.
- Voice commands (`features/commands.js`) and stop/goodbye phrases (`features/turns.js`) work in both languages.

## Names and settings in chat

- **The assistant's name is per account** (`preferences.assistantName`, 24 letters, validated in `src/modules/account/preferences.js` because it reaches the prompt). The wake phrase, every label and the prompt follow it: "Hey Claudia".
- **Settings by chat.** `settings.update` (in `src/modules/assistant/actions.js`) changes the name, interface language, voice-input language, wake word, animations, matching, theme and, on the current device, voice speed, style, gender and read-aloud. Account settings are saved on the server and can be undone; device settings are sent to the browser as a client effect and applied by `features/preferences.js`. The browser reports its voice settings with each message so "faster" and "what is my speed?" make sense; `CONTEXT` lists the current values.

## Campus map

`/campus/map` draws both campuses from OpenStreetMap data (`node scripts/oth-campus-map.js` builds `resources/oth-campus-map.json`; credit is shown on the map). A room such as "HSG 001", "WTC 1.25" or "EMI104" finds its building by code (`features/campus-places.js`). Your position comes from the browser's location and stays in the browser. Distance and walking time are estimates; *Directions* opens turn-by-turn in OpenStreetMap or Google Maps. `GET /api/campus/map/classes` lists the next lessons that have a room, from the person's schedule and the official timetable of their programme. Buildings that OpenStreetMap does not show (the E-House) are listed as not mapped instead of guessed. The assistant opens it with `app.navigate {"to":"map","place":"HSG"}`.

## Voice

The browser handles voice (`public/js/features/voice.js`):

- `wake`: the app-wide wake word. When a user turns on *Listen for "Hey Campus"*, one microphone session stays open on every page and reads phrases as they are spoken (interim results, so there is no wait). "Hey Campus, …" works anywhere in a phrase; a bare "Campus, …" only at its start, so "the campus library" never wakes it. Common mishearings (Compass, Campos, Kampus) are accepted. On hearing it, a chime plays, a "Listening" pill shows the words live, and after a short pause the command is sent. Saying the name alone waits about nine seconds for the command. While Campus talks, it ignores what it hears except "Campus, stop".
- The command goes first to `wake.setInterceptor` (the shell's local commands in `features/commands.js`: "open schedule", "dark mode", "new chat", "stop", "stop listening". They run instantly, even with AI off, and only match whole short sentences), then to the page that registered `wake.onCommand(fn)`, otherwise to the assistant.
- `dictate({ onInterim, onFinal, onEnd })` shows words as they are spoken and reuses the open wake session when there is one, so it starts at once. With "Hey Campus" on, a dictated message is sent automatically. `speak`/`stopSpeaking` (read-aloud, in sentence-sized pieces), `createSpeaker` (speaks an answer while it streams in) and `createCaptioner` (live captions in spaces).
- Read-aloud follows Settings → Assistant → *Read answers aloud*: when the question was spoken (the default), every answer, or never. The voice, a style (speed and pitch) and that choice are stored per device in `features/voices.js`, because voices belong to the browser and system.
- Speech is reliable by construction: queued utterances are kept in memory (Chrome drops the `end` event of one that is garbage-collected), and a watchdog ends speech the engine silently dropped, so nothing waits forever.

### Voice conversation

`features/conversation.js` is a hands-free conversation, like a phone call. It opens from the waveform button in the message box (shown while the box is empty), Ctrl/⌘K → *Talk to Campus*, or "Hey Campus, let's talk". It is an overlay on top of the app, so it survives page changes: the arrow button, or Campus opening a page, shrinks it to a pill.

```text
listening → hearing (live words) → thinking → speaking → listening …
```

- **Answers for the ear.** Questions go to `POST /api/assistant/messages` with `mode: 'voice'`, which swaps `FORMAT_GUIDE` for `VOICE_GUIDE`: one to three spoken sentences, no Markdown, lists or LaTeX, numbers as they are said, at most one question. Speech starts with the first sentence of the stream. Actions, citations and illustrations still work; everything is saved in the open thread (or a new one), and the assistant shows it when the conversation ends.
- **Turn-taking** (`features/turns.js`, tested in `tests/voice-conversation.test.js`). A turn ends after a pause: about a second once the speech service closes the phrase, longer when the sentence ends on "and", "because", "um" or "the", shorter for "yes" or "thanks". Tapping the eye (or Space) sends at once.
- **Interrupting.** On computers the microphone stays open while Campus talks. What it hears is compared with what Campus is saying: its own voice is ignored, and a stop word ("wait", "stop") or a few new words cut Campus off and become the next question. Phones send speech to the earpiece while the microphone is open, so there the microphone pauses while Campus talks and a tap interrupts. Speaking while Campus is still thinking replaces the question.
- **Spoken controls.** "Goodbye", "that's all" or "stop listening" end it; "stop" or "never mind" just quiets Campus. The local commands from `features/commands.js` work too ("open schedule", "dark mode", "new chat").
- **Microphone.** `createListener` in `voice.js` keeps one continuous recognition session and reopens it whenever the browser ends it, with back-off. It gives up only with a reason (blocked, no microphone, speech service unreachable, unsupported language, keeps stopping), shown with a *Try again* button. Words heard across a reopened session are kept, and Android's repeated phrases are merged. After two quiet minutes the microphone turns itself off. "Hey Campus" pauses during a conversation and resumes afterwards.
- Errors are explicit: a blocked microphone, no microphone, or a browser whose speech service cannot be reached (some privacy browsers and embedded webviews) turn the wake word off with a message instead of failing silently.
- `voiceProblem()` explains why voice is unavailable: unsupported browser, or a page not served over HTTPS or localhost.

To use an on-device engine (Whisper.cpp, Vosk) instead, replace `Recognition` in that file. Hardware pucks do their own speech-to-text and send text as `voice.query` events (see [HARDWARE.md](HARDWARE.md)).
