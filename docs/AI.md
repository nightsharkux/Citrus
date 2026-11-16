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

Citrus calls the [OpenAI-compatible gateway API](https://vercel.com/docs/ai-gateway/openai-compat) with Node's built-in `fetch`. There is no SDK dependency and the app can run outside Vercel.

1. Create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok/authentication) in the Vercel dashboard. Configure gateway credits and a per-key spending budget there; the app's per-user rate limit is not a spending cap.
2. Set these variables in the server's private `.env`:

   ```dotenv
   AI_GATEWAY_API_KEY=<your gateway API key>
   CAMPUS_AI_PROVIDER=gateway
   CAMPUS_AI_DEFAULT_MODEL=openai/gpt-6.1-sol/low
   CAMPUS_AI_SUMMARY_MODEL=openai/gpt-6-luna/low
   ```

3. Restart with `npm start`. In **Admin → AI & knowledge**, select **Vercel AI Gateway**, save and use **Test connection**. The institution's saved Gateway/Off choice takes precedence over `CAMPUS_AI_PROVIDER`. With no saved choice, Gateway is the default; a missing key leaves it inactive.
4. Import approved knowledge sources, then check citations, teaching answers and practice questions against your own examples. A successful connection test checks connectivity, not answer quality. `npm run check -- --ai` also makes one live default-model request per institution; ordinary `npm run check` makes none.

### Cost-conscious task routing

| Task | Default model | Environment override |
|---|---|---|
| Personal/workspace chat, tutoring, practice questions, classroom text answers and connection tests | `openai/gpt-6.1-sol/low` | `CAMPUS_AI_DEFAULT_MODEL`, or the institution's Assistant model choice |
| Meeting minutes, live-caption summaries, feedback themes and marking written quiz answers | `openai/gpt-6-luna/low` | `CAMPUS_AI_SUMMARY_MODEL` |
| Lookups in assistant chat and voice (`task: 'search'` / `'voice-search'`): web searches, messages with attached files, and factual questions about the university's documents (when, where, who, which office, deadline; `needsLookup` in `src/ai/latency.js`). Explanations, tutoring and actions stay with the default model | `google/gemini-3.8-flash/low` | `CAMPUS_AI_SEARCH_MODEL` (`off` keeps lookups on the default model) |
| Spoken conversations (`task: 'voice'`): the default model with a shorter reasoning level, so answers start quickly. Applies only when the default model slug has a level | `low` | `CAMPUS_AI_VOICE_REASONING` |
| Natural voices (text to speech, see [Voice](#voice)) | `elevenlabs/eleven-flash-v2.5` | `CAMPUS_AI_SPEECH_MODEL` (`off` uses browser voices) |

Feature modules mark summarization calls with the server-controlled `task: 'summary'`; other calls use the default model. Vercel AI Gateway is the only AI connection. Off disables model calls. The chosen default, summary and search models are shown in Admin. Clients cannot select arbitrary models or tasks.

Consult the [gateway catalog](https://ai-gateway.vercel.sh/v1/models) for current availability and prices. The choice of model, input size, output and reasoning tokens all affect the bill. The application keeps summary routing separate and never escalates to a more expensive model automatically.

Model settings accept `provider/model/reasoning`: the default uses low reasoning to reduce response delay, and summaries use low. The adapter removes the final segment from the model ID and sends it as `reasoning.effort` to the [gateway reasoning API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning). No separate reasoning environment variable is needed.

Omit the segment to use the model's own default, or use `/none` to disable reasoning where supported. Gateway effort names are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; only use a level supported by the selected model. The gateway validates model-specific support and translates the setting to the serving provider's controls. Malformed slugs and unknown effort names disable AI configuration before a request is sent.

The adapter preserves each feature's output token limit and sorts providers for the same model by time to first token (`ttft`) for interactive answers, and by cost for summaries. Reasoning tokens can consume the output budget and are billable. No fallback model or automatic premium-model escalation is configured. Evaluate the selected model against real teaching examples before relying on answer quality. Gateway may route the same model among its available providers; configure any required provider/data restrictions in Vercel.

Sol supports the current text Chat Completions requests and streaming. Native OpenAI tool calling with Sol requires the Responses API. Citrus continues to parse its existing app-action protocol from text; this change does not add native OpenAI tool calls. Sol and Astra require at least low reasoning; a deployment voice override of `none` or `minimal` uses low for those models.

The gateway key stays on the server. Stored recordings are not sent for automatic transcription. Live microphone recognition uses the selected speech service; see [SPEECH.md](SPEECH.md). Gateway and downstream provider data policies apply to prompts sent through this cloud option.

## Configuration and upgrades

Model settings use role-based names: `CAMPUS_AI_DEFAULT_MODEL` for the default model and `CAMPUS_AI_SUMMARY_MODEL` for summaries. Replace the earlier model variable names in your hosting settings, then redeploy.

Administrators can select GPT-6.1 Sol (low reasoning), GPT-6 Astra (high), GPT-6.1 Terra (medium) or GPT-6 Luna (low) in **Admin / AI & knowledge / Assistant model**. The choice is saved for that institution only and overrides the deployment's chat model. **Use deployment default** removes the override, preserving any explicitly configured deployment model. Sol is the code default when no deployment model is configured. Migration 013 moves the former Sol medium preset to low, preserving other choices. Summaries retain Luna by default, and voice retains the selected model with its shorter configured reasoning. There is no automatic switch to a more expensive model. Available model IDs and reasoning levels were checked against the public AI Gateway catalog and official OpenAI documentation on 2026-11-09; account credits and access still determine whether a request succeeds.

Streaming playback uses single-use model-bound grants through the same Gateway credential. `CAMPUS_AI_SPEECH_STREAMING=off` keeps buffered playback; explicit speech models and `off` are honored. The default Flash v2.5 has different pricing from the previous TTS default. See [SPEECH.md](SPEECH.md) for activation, model access and verification.

The AI settings are `AI_GATEWAY_API_KEY`, `CAMPUS_AI_DEFAULT_MODEL`, `CAMPUS_AI_SUMMARY_MODEL`, `CAMPUS_AI_PROVIDER` (`gateway` or `off`), `CAMPUS_AI_RATE_PER_MINUTE`, `CAMPUS_AI_SPEECH_MODEL`, `CAMPUS_AI_SPEECH_PER_MINUTE` (speech requests per user, default 240; buffered pieces and streaming grants share this quota) and `CAMPUS_AI_VOICE_REASONING`. Only the key is required to configure the gateway; the other values have defaults. The key stays in the server environment. Do not expose it through a browser variable or commit `.env`.

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
| Quizzes: writing them, marking written answers, the tutor | `modules/quiz` | `quizPrompt`, `quizGradePrompt` (summary model), `quizTutorPrompt` |
| Web search | `modules/assistant`, `ai/providers/gateway.js` | `WEB_GUIDE` |
| Natural voices | `modules/speech`, `ai/voices.js` | none (text to speech) |
| Feedback themes | `modules/admin` | `suggestionsPrompt` |
| Voice puck answers | `modules/devices` | `voicePrompt` |

## Citrus's face and illustrations

The assistant is called **Citrus** (`site.assistant` in `config/editions/*.js`). Its face is the ring from the logo, used as a robot eye (`public/js/features/face.js`). There is no pupil: the ring itself is the eye. It squashes flat to blink, slides and turns to look around, follows the pointer, follows the caret while someone types and looks back up when they stop. Every expression is a change in the ring's own shape, drawn as one SVG path each frame and moved with springs:

| Mood | The ring… |
|---|---|
| `idle` | breathes, blinks, glances around, now and then tilts curiously, squints or hops; drowsy (heavy lid) after a minute without activity |
| `listening` | opens wide and pulses |
| `thinking` | looks up to the side while a gap circles the ring |
| `speaking` | opens and closes with the loudness of Citrus's voice (`speechLevel()` from `speaker.js`), or a talking rhythm when no voice plays |
| `happy` | becomes an upturned arc and hops |
| `excited` | a wide smile that bounces (several right answers in a row, thanks) |
| `laugh` | a smile that shakes (jokes) |
| `curious` | tilts with a raised lid (a question going out, a hint) |
| `wink` | closes on one side for a moment (also an occasional idle gesture) |
| `surprised` | pops open, wide and thin |
| `confused` | tilts and wobbles with a slanted lid |
| `sad` | shrinks, droops and loses some colour (used when a request fails) |
| `asleep` | closes to a downturned arc (no model connected) |

Shapes live in `MOODS` in `face.js` (width, upper and lower height, slant, tilt, gap), so a new expression is one line. The springs settle a change of mood in about a fifth of a second with a little overshoot, a blink takes 140 ms, and `face.pulse()` widens the eye briefly each time the person's words come in during a voice conversation.

```js
import { createFace, faceGroup, watchTyping } from '/js/features/face.js';
const face = createFace({ size: 64 });            // face.el is the element to insert
face.setMood('thinking');  face.react('happy', 1500);
face.showVisual({ kind: 'formula', content: 'a^2 + b^2 = c^2' });  face.hideVisual();
const stop = watchTyping(textarea, face);          // eyes follow the caret
face.destroy(); stop();
```

**Illustrations.** While Citrus explains something, the eye can turn into a small animation. The model asks for one by starting its answer with a single line:

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

**What it already knows** (`src/ai/context.js`, built for every message from the user's own data only): the time and dates, role and programme, what is on right now and what comes next, enrolled courses with lecturer and next session, exams and deadlines for the next 60 days (a separate section so a busy week cannot push them out), the next 14 days of schedule, free time in the coming three days, topics the student marked as not understood, review items due, key points from recent lectures, spaces, unread notifications and recent conversation titles. Lecturers get how recent topics landed, as counts. `CONTEXT_GUIDE` tells the model to use all this instead of asking, to resolve "my exam" or "tonight" itself, and to say so when something is not in Citrus. Assignments exist only as `deadline` and `exam` events in the schedule; there is no separate gradebook, and the assistant is told not to guess. `GET /api/assistant` also returns `starters`, conversation openers built from the user's next exam, class or hard topic.

Pictures and documents (`modules/assistant/attachments.js`, UI in `public/js/features/attach.js`): the browser uploads each file as soon as it is added (button, paste or drop) to `POST /api/assistant/attachments` as base64 JSON, then sends the message with `attachments: [ids]`. Pictures are shrunk in the browser (longest side 1600 px, JPEG), checked by their bytes on the server and kept so follow-up questions can still look at them. They go to the model as `image_url` parts, so the selected model must accept images. Documents are read to text once on upload by `src/lib/extract-text.js` (text, Markdown, CSV, JSON, code, HTML, DOCX, PPTX, XLSX and text-based PDFs, with Node built-ins only) and reach the model as `ATTACHMENT` reference blocks, which the safety rules treat as untrusted. A scanned PDF has no text; the user is told to attach photos of the pages. Limits: 3 MB per file (Vercel caps request bodies at 4.5 MB), 6 files per message, 60,000 characters kept per document, the newest 4 pictures per request. Unsent uploads are removed after a day.

## Actions

Citrus can change things for the signed-in user, hands-free. The text-only chat API has no tool calling, so the model starts its answer with one line per action:

```text
[action: calendar.add | {"title":"Study session","start":"2026-11-10T16:00","duration_minutes":90}]

Adding a study session for tomorrow at 4 pm.
```

`src/ai/actions.js` removes these lines from the text (only at the very start, so nothing in the middle of an answer is ever run) and calls `src/modules/assistant/actions.js` as soon as each is complete, while the prose is still streaming. Each result is sent as an SSE `action` event, repeated in `done`, and stored in `assistant_messages.actions`. The page shows it as a card with *View* and *Undo*.

| Action | What it does |
|---|---|
| `calendar.add` / `calendar.update` / `calendar.delete` | The user's **own** personal events. Times are local (`YYYY-MM-DDTHH:mm`) in the institution's time zone. Overlaps are reported. Recurring events can change title or place, not time. |
| `calendar.classes` | A programme's weekly class timetable for one semester and start term (and group), into the user's own calendar: every class on every lecture day from today to the end of the lecture period, lecture-free days skipped. Times, rooms and lecturers come from the printed grid as `src/ai/lecture-plan.js` parsed it, never from the model. Classes split into groups are added only for the user's group; without one they are named in the result. Importing again adds nothing; undo removes the whole import. |
| `calendar.import` | All exam dates of DTM or IIE from the exam plan, exactly as printed. |
| `app.navigate` | Opens a page (limited to the pages the user's role has) or one of their courses. Carried out by the browser. |
| `app.theme` | Light, dark or system. Carried out by the browser. |

Safety rules, all enforced on the server:

- Actions run as the user through the same rules as the rest of the app, scoped to `user.institution_id`. Course and university-wide events, other people's events, posting and messaging are out of reach.
- Every change except navigation is audited (`assistant_action`) and can be undone once (`POST /api/assistant/messages/:id/actions/:index/undo`). The undo data never leaves the server.
- Text in notes, knowledge sources and transcripts cannot trigger actions: the prompt says so, and only the answer's leading lines are parsed. At most six actions run per answer.
- The model sees the schedule for 14 days with an `[id N]` on events it may change, plus a table of dates, and its own earlier actions in the history, so "move it an hour later" works.

**Adding an action:** add a function to `ACTIONS` in `src/modules/assistant/actions.js` returning `{ title, detail?, warning?, link?, client?, undo? }`, describe it in `ACTION_GUIDE` in `prompts.js`, and add a test with an access-denied case.

## What it knows about the university

Academic questions use the user-supplied `resources/CampusOS_OTH_AW_Academic_Data_2026-11-08.txt` snapshot. It contains 53 programme records, 182 extracted documents and 572 pages, plus academic calendar tables and feed events. The original UTF-8 file is retained unchanged. There is no schedule search or download at question time.

- `src/ai/academic-snapshot.js` parses source/page boundaries once per process, preserving fixed-width layouts, drawn regions, OCR confidence and coordinates. It resolves programme names and abbreviations in German/English and uses the last programme mentioned, otherwise the user's profile. Printed semester labels help rank pages; page numbers are never semester numbers.
- Programme-specific timetable, exam and curriculum questions use this snapshot ahead of the older website pack. General university information still uses `OTH_Public_Knowledge_2026-10-31.jsonl`, `OTH_Website_Knowledge.jsonl` and administrator-approved knowledge. Citrus geometry remains in `oth-campus-map.json`.
- References retain snapshot date, source ID, document metadata, page number and a PDF page link. Whole pages are selected within a bounded context budget; unusually long future pages are marked as partial. No whitespace flattening or conversion to inferred calendar events occurs. The old timetable/exam JSON files, duplicate academic JSONL packs, document index and `scripts/oth-timetables.py` were removed.
- The printed semester and entry cohort determine applicability. A summer 2026 exam plan is not a winter 2026/27 exam plan. Curriculum plans do not establish weekly meeting times. Unverified OCR, ambiguous grids and missing material are identified rather than guessed. The Corpus Christi 2027 discrepancy between the calendar webpage and ICS is preserved in both references.
- The map uses the student's own scheduled events for upcoming rooms. Snapshot layout/OCR data is not a validated events feed and cannot establish live room occupancy or personal enrolment.
- To refresh, provide a new public snapshot in the same format, review its dates and coverage, then update `academicSnapshot` in `config/editions/oth.js` and the literal reader in `src/lib/bundled.js`. The general website crawler remains available for non-schedule information. Existing private caches and storage are not accessed or removed by this change.
- `CAMPUS_BUNDLED_KNOWLEDGE=off` disables the snapshot as well as the other bundled packs. The general edition does not load OTH academic data.

## Web search

The assistant can search the web through the AI Gateway's Perplexity search tool, which works with any model. `providers/gateway.js` adds `{"type":"vercel:perplexity_search","config":{"max_results":6}}` to the Chat Completions request; the gateway runs the search, gives the results to the model and returns only the final answer, so `WEB_GUIDE` in `prompts.js` tells the model when to search (current or changing facts, things it does not reliably know, or when asked), to prefer the university's own SOURCES and CONTEXT, and to link every page it used as a Markdown link without inventing addresses.

- **When.** In automatic mode (`web: 'auto'`), `src/ai/latency.js` only attaches the search tool for explicit search requests or recognized changing external facts such as weather, news and current prices. Ordinary chat, explanations and local timetable questions use their existing context directly. The model decides whether to search when the tool is attached. This text heuristic does not cover every current-fact question; use the globe button to force search. The globe button in the message box makes every message search first (`web: 'on'` → `tool_choice: 'required'`; the stream then starts with `event: searching` and the page shows "Searching the web"). `web: 'off'` never searches. Voice conversations use automatic search.
- **Sources.** Pages the answer links to after a search are added to the message's sources with `{ web: true, site }` and shown with a globe and the site's name, after the library's numbered sources.
- **Switch and fallback.** Administrators turn it off in Admin → AI & knowledge → Tools (`institution_ai_settings.web_search`, migration 009). If the gateway refuses a request because of the tool (search not enabled for the account), the same request is sent again without it, so the assistant still answers, and search rests for 15 minutes. Searches cost about $5 per 1,000 on the gateway.

## Quizzes

`/quiz` (`public/js/pages/quiz.js`, `src/modules/quiz`) makes practice quizzes like a tutor's, from a topic, one of the person's courses (its topics and the ones they found hard) or their own pasted notes. Topic quizzes are grounded in the knowledge library when it has something on the topic. Saying "quiz me on…" to the assistant runs the `quiz.start` action, which opens `/quiz/new?topic=…` and writes the quiz at once. In a voice conversation Citrus quizzes out loud instead, one question at a time.

- **Eight kinds** (`questions.js`): multiple choice, select all that apply (partial credit, a wrong pick costs a right one), true or false, fill in the blank (a one-letter typo in a long word still counts), short answer (marked by the summary model with feedback, or by its key points if the model is unavailable), put in order, match, and calculations (with a tolerance and unit; German decimal commas work).
- **Honest by construction.** The model's JSON is checked kind by kind; broken or duplicate questions are dropped. The page never receives an answer before the question is answered; order items and match descriptions are shuffled the same way on every visit. Each question is answered once; the server marks it and returns the score, the explanation and the right answer.
- **Like a tutor.** Every question has a hint, an explanation and *Ask the tutor*: a short chat about that question (`quizTutorPrompt`) that guides without giving the answer away until the question is answered. The student's written answer reaches the marking model fenced as data, never as instructions.
- **Afterwards.** Results with a review of every answer, *Practise my mistakes* (a new quiz from the questions not fully right), and for students the missed questions also join the spaced review queue.

## Languages

Live recognition defaults to OpenAI GPT Live Transcribe through Gateway when no Wispr or Deepgram configuration overrides it. Deepgram Nova-3 also supports simultaneous German/English decoding. Capture requests WebRTC microphone processing. The existing browser recognizer remains the fallback. Account activation and testing are documented in [SPEECH.md](SPEECH.md).

People here use German and English together, often in one sentence. `LANGUAGE_GUIDE` in `src/ai/prompts.js` tells the model that this is normal: mixed sentences, German words and place names inside English ("Banhof", "Schirmitzer Weg"), missing umlauts, broken grammar and speech-recognition errors in both languages. It answers in the language of the latest message, keeps official German terms with a short gloss and understands German dates ("halb drei", "übermorgen"). The same guide is in the classroom voice and workspace prompts.

- **Interface.** `public/js/core/i18n.js` translates what is on screen from the dictionary in `i18n-de*.js` (text, placeholders, labels, toasts) and follows each person's language setting, then the browser. Add a string by adding its English text and the German beside it. Text people wrote is never touched. Unmapped interface strings retain their original text. The account menu offers a page translation, including content outside the dictionary, in a separate sheet; the original is unchanged.
- **Answers and translations.** Settings / Assistant / Name and language includes an answer-language choice: follow the latest message, always German, or always English. An explicit request for another language overrides the preference for that turn. Mixed or broken phrasing and sudden switches are handled without comment. Existing answers have Deutsch/English translation buttons. `POST /api/assistant/translate` calls `deps.ai` with the translation prompt, checks ownership for saved messages, and never runs the action executor. Translations require a configured AI provider and are not saved over original content.
- **Voice.** Browser recognition listens for one language at a time; external recognition supports automatic multilingual input. *Voice input language* is Automatic (follow the language you spoke last), English or Deutsch; "auf Deutsch" and "in English" switch it by voice. Answers are read piece by piece in the language they are written in, with a voice chosen per language (Settings → Assistant → Voice). `detectLanguage` in `features/turns.js` tells the two apart by common words and umlauts.
- Voice commands (`features/commands.js`) and stop/goodbye phrases (`features/turns.js`) work in both languages.

## Names and settings in chat

- **The assistant's name is per account** (`preferences.assistantName`, 24 letters, validated in `src/modules/account/preferences.js` because it reaches the prompt). The wake phrase, every label and the prompt follow it: "Hey Claudia".
- **Settings by chat.** `settings.update` (in `src/modules/assistant/actions.js`) changes the name, interface language, answer language, voice-input language, wake word, animations, matching, theme and, on the current device, voice speed, style, gender and read-aloud. Account settings are saved on the server and can be undone; device settings are sent to the browser as a client effect and applied by `features/preferences.js`. The browser reports its voice settings with each message so "faster" and "what is my speed?" make sense; `CONTEXT` lists the current values.

## Campus map

`/campus/map` draws both campuses from OpenStreetMap data (`node scripts/oth-campus-map.js` builds `resources/oth-campus-map.json`; credit is shown on the map). A room such as "HSG 001", "WTC 1.25" or "EMI104" finds its building by code (`features/campus-places.js`). Your position comes from the browser's location and stays in the browser. Distance and walking time are estimates; *Directions* opens turn-by-turn in OpenStreetMap or Google Maps. `GET /api/campus/map/classes` lists the next lessons that have a room, from the person's own schedule (snapshot pages are not converted into calendar events). Buildings that OpenStreetMap does not show (the E-House) are listed as not mapped instead of guessed. The assistant opens it with `app.navigate {"to":"map","place":"HSG"}`.

## Voice

The browser handles voice (`public/js/features/voice.js`):

- `wake`: the app-wide wake word. When a user turns on *Listen for "Hey Citrus"*, one microphone session stays open on every page and reads phrases as they are spoken (interim results, so there is no wait). "Hey Citrus, …" works anywhere in a phrase; a bare "Citrus, …" only at its start, so "the campus library" never wakes it. Common mishearings (Compass, Campos, Kampus) are accepted. On hearing it, a chime plays, a "Listening" pill shows the words live, and after a short pause the command is sent. Saying the name alone waits about nine seconds for the command. While Citrus talks, it ignores what it hears except "Citrus, stop".
- The command goes first to `wake.setInterceptor` (the shell's local commands in `features/commands.js`: "open schedule", "dark mode", "new chat", "stop", "stop listening". They run instantly, even with AI off, and only match whole short sentences), then to the page that registered `wake.onCommand(fn)`, otherwise to the assistant.
- `dictate({ onInterim, onFinal, onEnd })` shows words as they are spoken and reuses the open wake session when there is one, so it starts at once. With "Hey Citrus" on, a dictated message is sent automatically. `createCaptioner` gives live captions in spaces.
- Read-aloud follows Settings → Assistant → *Read answers aloud*: when the question was spoken (the default), every answer, or never. The voice, a style (speed and pitch) and that choice are stored per device in `features/voices.js`.

### Citrus's voice (speaking)

Everything Citrus says goes through `public/js/features/speaker.js` (`speak`, `createSpeaker`, `stopSpeaking`, re-exported by `voice.js`). An answer is spoken while it streams in, cut at sentence ends (`speakBoundary` in `turns.js`, never inside formulas or code). There are two engines:

- **Streaming natural voices** (default when available). ElevenLabs Flash v2.5 uses one Gateway WebSocket per answer, opened while the chat model starts its response. Text is sent as sentences become available, and mono 24 kHz PCM plays as it arrives. A measured recognition pause is deducted from turn timing instead of counted twice. Volume changes apply to active natural playback; Replay answer and Stop sample are available. See [SPEECH.md](SPEECH.md) for grants, cancellation and fallbacks.
- **Buffered natural voices** (explicit non-streaming models or streaming startup fallback). `POST /api/speech` (`src/modules/speech`) turns a piece of text into audio with the AI Gateway's text-to-speech endpoint (`https://ai-gateway.vercel.sh/v4/ai/speech-model`, model in the `ai-model-id` header, audio back as base64). The first sentence goes alone so speech starts quickly; later ones go two or three at a time, which sounds more natural. The next piece is fetched while the current one plays, and all pieces are scheduled back to back on one Web Audio clock, so there are no gaps. An analyser gives `speechLevel()`, which the face's mouth follows.
- **Device voices** (`speechSynthesis`), when natural voices are off, unavailable or the person prefers them. One sentence at a time, never a queue (Chrome skips some of a long queue and drops the first utterance after a cancel). Each sentence has a watchdog; a dropped sentence is retried once, and repeated failure reports blocked playback. Pieces over 170 characters are split (Chrome's online voices stop after about 15 seconds).
- Buffered natural speech can continue in the device voice after a failed piece. A broken PCM stream reports failure and can be replayed without automatically repeating audible words. Refused streaming startups rest for a minute and use buffered speech. One answer keeps one language: it switches only for a long passage clearly in the other language, so a stray "Okay." in a German answer does not change the voice.
- **Voices.** `src/ai/voices.js` lists the voices of each speech model family (OpenAI `tts-1`: Nova, Shimmer, Alloy, Echo, Fable, Onyx; Gemini: Kore, Puck, Zephyr, Charon, Aoede, Leda; Microsoft MAI-Voice: Harper, Ethan, Mia; ElevenLabs: Bella). Only voices from the providers' documentation are listed, a voice the server does not know becomes the default, and a German sentence is never sent to an English-only voice. Models supporting delivery instructions receive clear pronunciation, an audible conversational volume and a steady pace. People choose the voice in Settings → Assistant → Voice, with a sample for each.
- **Cost and limits.** Streaming uses one model-bound grant per answer; buffered speech uses one request per piece. Speech has its own allowance (`CAMPUS_AI_SPEECH_PER_MINUTE`, default 240 per user). Buffered audio is cached in memory (24 MB) per user and institution; streaming audio is not cached. Administrators turn natural voices off in Admin → AI & knowledge → Tools. Text to speech is in beta on the gateway and access is rolling out gradually; until the account has it, the server's first refusal rests natural voices and browsers use their own.
- `tests/speaker.test.js` runs `speaker.js` against simulated browser engines: one sentence at a time and in order, a dropped sentence skipped, stopping at once, one language per answer, natural audio back to back without gaps or overlaps, and the hand-over to the device voice without losing words.

### Voice conversation

`features/conversation.js` is a hands-free conversation, like a phone call. It opens from the waveform button in the message box (shown while the box is empty), Ctrl/⌘K → *Talk to Citrus*, or "Hey Citrus, let's talk". It is an overlay on top of the app, so it survives page changes: the arrow button, or Citrus opening a page, shrinks it to a pill.

```text
listening → hearing (live words) → thinking → speaking → listening …
```

- **Answers for the ear.** Questions go to `POST /api/assistant/messages` with `mode: 'voice'`, which swaps `FORMAT_GUIDE` for `VOICE_GUIDE`: one to three spoken sentences, no Markdown, lists or LaTeX, numbers as they are said, at most one question. Speech starts with the first sentence of the stream. Actions, citations and illustrations still work; everything is saved in the open thread (or a new one), and the assistant shows it when the conversation ends.
- **Turn-taking** (`features/turns.js`, tested in `tests/voice-conversation.test.js`). A turn allows breathing and thinking pauses: about 2.2 seconds for an ordinary unfinalized phrase, around four seconds after connectors or filler words, and less for a complete short reply. Gateway capture remains open while transcription connections change and buffers audio during setup. Gateway partials cannot submit a question or execute a wake-word action; final corrected text and any queued speech must finish first. Tapping the eye (or Space) requests immediate finalization before sending.
- **Interrupting.** On computers the microphone stays open while Citrus talks. What it hears is compared with what Citrus is saying: its own voice is ignored, and a stop word ("wait", "stop") or clearly new speech (at least three new words in a finished phrase, five while it is still being said) cuts Citrus off and becomes the next question. When the microphone listens in one language while Citrus speaks the other, its own voice comes back as nonsense words that all look new, so then only a stop word interrupts. Cutting Citrus off by mistake was the main cause of answers stopping halfway. Phones send speech to the earpiece while the microphone is open, so there the microphone pauses while Citrus talks and a tap interrupts. Speaking while Citrus is still thinking replaces the question.
- **Spoken controls.** "Goodbye", "that's all" or "stop listening" end it; "stop" or "never mind" just quiets Citrus. The local commands from `features/commands.js` work too ("open schedule", "dark mode", "new chat").
- **Microphone.** `createListener` in `voice.js` keeps one continuous recognition session and reopens it whenever the browser ends it, with back-off. It gives up only with a reason (blocked, no microphone, speech service unreachable, unsupported language, keeps stopping), shown with a *Try again* button. Words heard across a reopened session are kept, and Android's repeated phrases are merged. After two quiet minutes the microphone turns itself off. "Hey Citrus" pauses during a conversation and resumes afterwards.
- Errors are explicit: a blocked microphone, no microphone, or a browser whose speech service cannot be reached (some privacy browsers and embedded webviews) turn the wake word off with a message instead of failing silently.
- `voiceProblem()` explains why voice is unavailable: unsupported browser, or a page not served over HTTPS or localhost.

To use an on-device engine (Whisper.cpp, Vosk) instead, replace `Recognition` in that file. Hardware pucks do their own speech-to-text and send text as `voice.query` events (see [HARDWARE.md](HARDWARE.md)).

## Reading uploaded documents

`ai.read({ user, system, prompt })` reads one uploaded page with the lookup model (`CAMPUS_AI_SEARCH_MODEL`, Gemini Flash by default) and has its own allowance (`CAMPUS_AI_READ_PER_MINUTE`, 60), so a long scan neither waits for nor uses up the chat's. A prompt may carry `images` (data URLs) or one PDF in `files` (`{ name, mime, data }`, sent as a Chat Completions `file` part). `src/modules/library/service.js` decides per file:

| File | How it is read |
|---|---|
| PDF with readable text | Text layer, one entry per page (or per part when the content order does not match the page count) |
| Scanned PDF | Each page picture (JPEG as is; grey, black-and-white or RGB pictures re-encoded as PNG) by the AI |
| PDF with undecodable fonts and no page pictures | The PDF itself, five pages per request, `=== PAGE n ===` markers |
| Photo, screenshot | The AI (`knowledgeReadPagePrompt`: exact transcription, tables as rows, `[Figure]`, `[unreadable]`) |
| Word, PowerPoint, Excel, text | Text extraction, by part, slide or sheet |
| `.jsonl` or the corpus `.txt` | Imported as it is |

Afterwards `knowledgeCardPrompt` writes a short card (title, type, summary, applies to, key facts, keywords) that becomes the document's overview entry. Pages read by the AI are labelled "read from a picture by AI (unverified)" in the entry and `READ_METHOD=ai-vision` in the download.

## Live lectures and meetings

Students' questions about a lecture (`liveStudentAskPrompt`) and explanations of their flags (`liveFlagExplainPrompt`) use the lookup model with the lecture's transcript by minute, the lecturer's notes and the student's own flags. The lecturer's "Ask" also receives the flags (`FLAGS` block, anonymous). During a meeting the space assistant also sees what has been said so far, and ending the meeting runs `meetingPrompt` over the notes and captions taken since it started.

## Graphs

`CHART_GUIDE` (in the chat and space prompts) asks the model for a fenced ` ```chart ` block with JSON whenever a graph is asked for or clearly helps: `type`, `title`, `caption`, `x`/`y` with labels and ranges, `series` (points or values), `functions` (formulas in x), `lines` and `annotations`. `public/js/core/markdown.js` hands the block to `core/chart.js`, which draws a self-contained SVG on white with round-number ticks, a light grid, labelled axes and a legend. Formulas go through a small parser (+ - * / ^, functions, pi, e); nothing is evaluated as code. `core/chart-actions.js` copies the figure as PNG or saves it as PNG or SVG.

## Presentation: "What is Citrus?"

`features/pitch.js` decides when a heard phrase asks Citrus to explain itself and holds the explanation, in English and German; `features/pitch-show.js` shows and speaks it with the face set to excited. It is checked before the wake word in the always-on listener, in voice conversations, and (only together with the wake word) on lecture and meeting microphones. The explanation is fixed text, so it works without the model.

## Made tools

`toolMakerPrompt` and `toolChangePrompt` ask the main model for a JSON tool: a name, a description, an icon and an HTML fragment that uses the theme's classes and CSS variables. `src/modules/apps/frame.js` wraps it in a page with four looks (glass, bold, minimal, night) and serves it with a CSP sandbox: inline script only, no network, no forms, its own origin. Ideas outside the guidelines come back as `{"refused": …}`. Shared tools wait for an administrator.

## Meeting minutes

Minutes use the main model (`task: 'chat'`), not the summary model: they are judged on the details they keep. `meetingPrompt` asks for summary, decisions, an action-item table, key details (numbers, dates, rooms, names as said), discussion, questions raised (including questions put to Citrus during the meeting) and open points. `minutesVersionsPrompt` turns finished minutes into one or more new files from an instruction ("with and without the student questions").
