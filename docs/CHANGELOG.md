# Changelog

## 1.1.0 (November 2026)

### Added
- **Hosted database.** Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` and Campus OS stores everything in Turso instead of `storage/campusos.db`, so it can run on Vercel (`src/db/remote.js`, no new dependencies). Keys that normally live in `storage/` move to the `app_keys` table (migration `005`), or come from `CAMPUS_MASTER_KEY` and `CAMPUS_NFC_KEY`. The server now listens when Vercel loads it. Recordings are unavailable without a disk.

### Changed
- **No `PUBLIC_URL`.** Campus OS reads its address from the `VERCEL_*` variables Vercel sets, defaults to localhost elsewhere, and links follow each visitor's address. `TRUST_PROXY` and `COOKIE_SECURE` default on in Vercel. Behind your own proxy set `COOKIE_SECURE=1` and, for single sign-on, `OIDC_REDIRECT_URI`.
- **Name and brand.** The product is now **Campus OS** and the assistant is **Campus**. The new wordmark uses the edition's gradient ring as its O. The same ring is used for the favicon, the app icons (regenerated for both editions) and `/brand/mark.svg`.
- The assistant name is now part of the product, so the per-user and per-space name settings are gone. Older saved values are ignored.

### Added
- **Campus's face.** The ring itself is an animated robot eye, with no pupil. It squashes flat to blink, slides and turns to look around, follows the pointer, follows the caret while you type and looks back up when you stop. Its shape shows how it feels: a gap circles the ring while it thinks, it turns into an upturned arc when an answer lands, pops open when stopped, droops when something fails, and closes when no model is connected. It shows on the assistant, home and settings screens, and as a static mark next to answers.
- **Animated explanations.** While Campus explains something, its eye turns into a small animation: a formula, a counter, bars, a sorting pass, steps, stick figures, a cycle, a clock, code, an idea or a trend. The model asks for one with a one-line cue that the server strips and streams separately (`src/ai/visuals.js`, migration `004`). There is a cautious fallback when the model gives no cue. Illustrations can be replayed from the answer and turned off in Settings.
- **Full-screen chat.** Use the button in the header, Ctrl/⌘K → *Ask Campus in full screen*, or `/assistant?full=1`. Esc leaves it.
- **"Hey Campus" on every page.** Say "Hey Campus, …" or just "Campus, …". A microphone indicator in the top bar shows when it is listening and turns it off with one click. A switch in Settings → Assistant turns it on or off.
- **Other devices.** With `HOST=0.0.0.0` (the new default), the startup window and Admin → *Institution* list the addresses phones and laptops on the same Wi-Fi can open. Links follow the address each visitor used when `PUBLIC_URL` is empty. `share-online.bat` / `npm run share` starts a temporary HTTPS link through a Cloudflare quick tunnel.

### Fixed
- The assistant page no longer scrolls the whole window on desktop and mobile.
- The sidebar keeps the account menu visible on short screens. Only the menu scrolls.
- `npm run check` and `npm run backup` now read `.env`.

### Tests
- 51 automated tests, including the hosted-database driver against a protocol stand-in. `CAMPUS_TEST_DB=turso npm test` runs the whole suite that way.
- Visual cues under any stream chunking, the brand mark and manifest per edition, and migration 004.

## 1.0.0 (November 2026)

### Rebuilt
- **Back end restructured** into `src/` with a router, one module per feature, a composition root (`src/app.js`), numbered transactional migrations and central configuration. All existing API paths keep working, and 0.6 databases upgrade in place.
- **New front end** made of dependency-free ES modules: a safe `html``` template, router with page lifecycle, live updates over SSE, sheets and toasts, a command palette (Ctrl/⌘K). It replaces four stacked UI layers (`app.js`, `collaboration-ui.js`, `experience-ui.js`, `studio-ui.js`, `one/*`).
- **New design system:** frosted-glass surfaces over a soft aurora, edition accents, light, dark and system themes, a gradient home hero with circular quick actions, a floating mobile tab bar, and motion that respects reduced-motion settings.

### Added
- **Assistant:** conversation threads, streamed answers, Markdown, citations from the knowledge library, personal context, dictation, read-aloud, a custom assistant name and an optional hands-free wake phrase. Anthropic joins Ollama and OpenAI as a provider.
- **Knowledge library:** source links, categories, freshness labels, JSONL/Markdown/text import, one-click import of the bundled OTH public pack, and public search with sources.
- **Schedule:** course, personal and university-wide events, weekly repeats that are safe across daylight-saving changes, ICS import, a private subscription feed, and notifications to enrolled students.
- **Learning:** spaced review queue, practice sets (AI-written with validation, or the lecturer's own checks), per-course progress, and instant feedback on concept checks.
- **Spaces:** live captions with topic marking that feeds the linked course, a caption summary, a recorder with a live level meter, note deletion, leave and archive, and minutes printed without pop-ups.
- **Campus:** event dates, locations and RSVPs, interest tags and opt-in matching, publisher rights, post removal, a campus guide (maps, directions, official links) and room status.
- **Check-in:** rotating six-digit codes with a countdown ring and full-screen mode, card pairing at a reader, and a live roster.
- **Device gateway:** HMAC-signed device API with replay protection, long-poll commands, door lights that follow room status, NFC pairing, tap-to-confirm lecturer sessions, voice questions and an end button. Includes a Node simulator and a Python reference client.
- **Inbox:** notification centre, Web Push (VAPID + RFC 8291, no dependencies), quiet hours and topic levels.
- **Accounts:** OpenID Connect SSO (PKCE, signature/issuer/audience/nonce checks), login lockout, password change, session list and revoke, personal data export and account deletion.
- **Admin:** overview, people (roles, publishers, sign-out), moderation with reports and AI feedback themes, devices, institution settings (registration, SSO-only, recording retention), integration status and audit log.
- **Moodle connector** using personal web-service tokens, encrypted at rest.
- `docs/AI.md`, `docs/HARDWARE.md`, a generated `docs/API.md`, and `AGENTS.md`.

### Security
- Content-Security-Policy and hardened headers, CSRF origin checks, per-account lockout and per-IP rate limits, secrets encrypted at rest, push endpoint allow-list (no SSRF), and a single-use SSO state.

### Tests
- 29 automated tests, up from 13. The original behaviour tests are unchanged and still pass.

## 0.6.0
- CampusOS One integrated preview (see `backups/v0.6.0-original/`).
