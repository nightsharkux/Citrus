# Architecture

Citrus is a single Node.js process (Node 22.13+ built-ins only: `node:http`, `node:sqlite`, `node:crypto`), with a dependency-free ES-module front end. There is no build step. Every file you see is the file that runs.

## Request flow

```text
HTTP request
  └─ src/app.js handler
       ├─ security headers (CSP, frame, referrer, permissions)
       ├─ router.match(method, path)            /api/v1/* also matches /api/*
       │    ├─ CSRF check (Origin / Sec-Fetch-Site) for state-changing requests
       │    ├─ session → ctx.user                (route option auth: 'user' | 'public' | 'device')
       │    ├─ role check                        (route option roles: [...])
       │    └─ handler(ctx) → returned object is sent as JSON (ctx.status sets the code)
       ├─ /api/* without a route → 404 JSON
       └─ static files, or index.html for in-app routes like /courses/12
Errors: throw HttpError (src/http/errors.js) → { error } JSON with that status.
```

## Back end layout

| Path | Responsibility |
|---|---|
| `server.js` | Loads config, opens the DB, runs migrations, seeds, starts HTTP. Requiring it builds the app without listening (the tests rely on this). |
| `src/config.js` | **Every** environment variable the server reads, with its default. AI keys are the exception: providers read them lazily. |
| `src/app.js` | The composition root. It builds shared services once, puts them in `deps`, and calls `register(router, deps)` on each module in `MODULES`. |
| `src/http/` | Router, body parsing, errors, security headers, rate limiting, static serving (Brotli or gzip for text files, ETags per encoding). |
| `src/db/` | `database.js` (helpers `get/all/run/insert/transaction`, local SQLite file), `remote.js` (the same API against hosted Turso), `migrate.js`, `migrations/NNN-*.js`, `seed.js`. |
| `src/services/` | Cross-cutting services: `access` (all permission checks), `audit`, `settings`, `rooms`, `maintenance`. |
| `src/modules/<area>/` | One folder per feature. `routes.js` exports `register(router, deps)`. Stateful logic lives in `service.js`. |
| `src/ai/` | Providers (chat, web search and text to speech through the AI Gateway), prompts, retrieval, personal context, the natural-voice catalog (`voices.js`), and `service.js` (the single AI entry point). See [AI.md](AI.md). |
| `src/realtime/bus.js` | Server-Sent Events pub/sub. The channels are `user:<id>`, `institution:<id>`, `course:<id>` and `workspace:<id>`. |
| `src/connectors/` | Integrations with external systems (Moodle today). |
| `src/lib/` | Pure helpers: crypto, validation, time zones, ICS, BM25 search, local network addresses. |

### The `deps` container

`db, config, site, env, access, bus, audit, settings, secretBox, nfcKey, ai, push, notifier, timetable, review, participation, deviceCommands, rooms, sessions, oidc, moodle, buildContext`

A module takes only what it needs: `register(router, { db, access, notifier })`.

### Conventions

- **Permissions live on the server, always.** Use `access.course()`, `access.teachingCourse()`, `access.workspaceMember()` and the other helpers in `services/access.js`. Never trust the client or an AI model to decide access.
- **Validation:** `lib/validate.js` (`text`, `id`, `oneOf`, `email`, `isoDate`, `httpUrl`) throws a readable 400.
- **Institution isolation:** every query that touches institution data filters by `user.institution_id`.
- **Audit:** call `audit(user, 'action_name', detail)` for anything security-relevant.
- **Notify:** `notifier.notify(userIds, { kind, title, body, link, category?, priority?, urgent? })`. One call stores the item in the inbox, pushes it live to open tabs, and sends Web Push.
- **Realtime:** `bus.publish('course:12', 'course.updated', {...})`. Pages subscribe with `ctx.live.on(...)`.
- **Secrets at rest** (device keys, connector tokens) go through `secretBox.seal/open`, AES-256-GCM with `storage/master.key`.
- **Schema changes:** add `src/db/migrations/NNN-name.js` and register it in `migrations/index.js`. Keep migrations additive. Never edit one that has shipped.

### Storage (back up as one unit)

With `TURSO_DATABASE_URL` set, the database and the three key entries live in Turso (`app_keys`) and only audio recordings need a disk. The rest of this section describes the default local setup.

`storage/citrus.db` (plus `-wal`/`-shm`), `storage/audio/`, `storage/master.key`, `storage/nfc-hmac.key` and `storage/vapid.json`. Losing `master.key` makes device secrets and Moodle tokens unreadable. Losing `nfc-hmac.key` unlinks every card.

## Front end layout

```text
public/index.html          shell (server injects edition + accent), loads js/main.js as a module
public/js/main.js          boot: /api/bootstrap → mount app or public frame → router
public/js/shell.js         sidebar, top bar, mobile tab bar, command palette (Ctrl/⌘K), sign-out, theme
public/js/nav.js           navigation per role (edit here to change menus)
public/js/routes.js        URL → page module (lazy-loaded)
public/js/core/            dom (safe html``), api (+SSE stream), router, store, live (SSE), ui (toasts, sheets,
                           confirm, menus, onSubmit), components, icons, brand (wordmark, ring), format,
                           markdown + math (Markdown and LaTeX → HTML/MathML for answers)
public/js/features/        face (Citrus's animated eye), face-visuals (its illustrations), speaker (everything
                           Citrus says: natural voices from the server or the browser's), voice (dictation,
                           "Hey Citrus" wake word, read-aloud, captions, conversation microphone),
                           voices (voice choice), conversation (hands-free voice conversation),
                           turns (its turn-taking rules, tested in Node), commands (spoken commands
                           that need no AI), recorder, push, print
public/js/pages/           one module per screen; admin/ for admin screens
public/css/                tokens.css → base.css → components.css → layout.css → pages.css, plus face.css
                           (wordmark, the face and its illustrations, full-screen chat, voice conversation)
public/sw.js               offline shell + Web Push; never caches /api/
```

### Page contract

```js
export default {
  title: 'Schedule',                 // or (data, ctx) => string
  roles: ['lecturer', 'admin'],      // optional
  public: true,                      // optional: reachable when signed out
  layout: 'wide',                    // optional: 'wide' | 'full'
  async load(ctx) { return api.get('/timetable'); },
  render(data, ctx) { return html`<h1>${data.title}</h1>`; },   // pure
  mount(root, data, ctx) { /* events; return a cleanup function */ },
};
// ctx = { params, query, navigate(path), refresh(), live.on(type, fn), setTitle }
```

`html```` escapes every interpolation. Nested `html```` templates and `icon()` are passed through. Use `raw()` only for markup you generated yourself.

### Design system

Tokens are in `css/tokens.css`: colours, radii, shadows, blur, motion. The editions override the accent and aurora colours, and the themes (light, dark, system) override the surfaces. Surfaces are frosted glass (`.card`, `.sheet`, `.tabbar`) over a slowly drifting aurora, with one gradient `.hero` per page at most. All motion respects `prefers-reduced-motion`.

The brand is the wordmark "Citrus", whose O is the gradient ring (`wordmark()` in `core/brand.js`), and the ring on its own (`ringMark()`, `/brand/mark.svg`). Both take the edition's aurora colours, so a new edition re-colours them automatically. The assistant's face is the same ring drawn as an eye. See [AI.md](AI.md#campuss-face-and-illustrations).

## Adding a feature (checklist)

1. **Back end:** create `src/modules/<feature>/routes.js` with `register(router, deps)` and add it to `MODULES` in `src/app.js`. If you need a table, add a migration.
2. **Permissions:** add or use a helper in `services/access.js`, and filter by institution.
3. **Front end:** create `public/js/pages/<feature>.js`, add the route in `routes.js` and the menu entry in `nav.js`.
4. **Registry:** add the item to `config/capabilities.js` with an honest status. Use `planned` until it works, and `available` only once an automated test covers it.
5. **Tests:** add `tests/<feature>.test.js` using `tests/helpers.js` (`startApp`, `register`, `login`, `lecturer`, `call`). Include an access-denied case.
6. Run `npm test`.

## Editions

`config/editions/*.js` hold the name, assistant name, palette, time zone, campuses, official links and an optional knowledge pack. Select one with `CAMPUS_EDITION`. To add an edition, add a file and register it in `config/site.js`.

## Known limits (honest)

- Single process with an in-memory rate limiter, SSE bus and long-poll waiters. Scaling out needs Redis or Postgres for those three.
- SQLite with WAL is fine for one faculty. For a whole university, plan a move to PostgreSQL. The query helpers are isolated in `src/db/database.js`.
- The hosted database driver (`src/db/remote.js`) keeps the synchronous API by blocking the calling thread during each query. Fine for a pilot with the database near the server; a larger deployment should make the data layer asynchronous.
- Speech recognition uses explicitly configured Wispr Flow or Deepgram Nova-3, otherwise OpenAI live transcription through a configured AI Gateway, or the browser vendor's service. Natural speech defaults to streamed ElevenLabs Flash v2.5 through Gateway. Audio access depends on the provider account. Capture requests WebRTC echo cancellation and noise suppression. See [SPEECH.md](SPEECH.md) for activation and limitations. Telling Citrus's own voice from the user's also uses a word-overlap heuristic; on phones the microphone pauses while Citrus speaks, so interrupting there takes a tap.
- Native store apps, BLE proximity and vendor equipment control are not built. They're marked *In development*.
