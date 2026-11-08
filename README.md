# Campus OS 1.1

A university platform built around one calm home screen and **Campus**, an assistant that knows your courses. Students, lecturers and administrators each get their own views. One codebase serves several institution themes (an OTH Amberg-Weiden concept edition and a general edition).

> **Status:** a production-structured pilot. The code is complete and tested, but a real university deployment still needs HTTPS, your identity provider, a data-protection review and institutional approval. The OTH edition is an independent concept, **not** an official OTH Amberg-Weiden service.

## What's inside

| Area | What it does |
|---|---|
| **Campus (assistant)** | Threaded conversations, streamed answers, citations from the approved knowledge library, personal context (your courses, schedule, review queue), dictation and read-aloud. An animated eye that reacts, follows what you type and turns into small illustrations while it explains. A full-screen mode, and "Hey Campus" on any page. Vercel AI Gateway with configurable default and summary models. |
| **Learning** | Courses → lectures → topics. Private understanding ratings, concept checks with live class results, a spaced-review queue, practice sets (AI-written or from the lecturer's checks), per-course progress. |
| **Schedule** | Course, personal and university-wide events. Weekly repeats keep their local time across daylight-saving changes. ICS import and a private subscription link for phone calendars. |
| **Spaces** | Invite-code rooms with shared notes, an assistant with lecturer-defined behaviour, meeting recording (private by default) with a live level meter, draft minutes, and live captions. |
| **Campus** | A moderated feed with events and RSVPs, jobs, housing and research calls. Opt-in interest matching. A campus guide with maps, official links and knowledge search. Room status. |
| **Check-in** | Participation sessions with a rotating six-digit code, lecturer confirmation, or card taps on a registered reader. |
| **Devices** | A signed device API for classroom pucks, NFC readers and door lights. Tapping a card starts a session only after the lecturer confirms it in the app. |
| **Inbox** | Notifications with Web Push, quiet hours, topic preferences and plain-language settings ("mute events"). |
| **Accounts** | Local login with lockout, OpenID Connect single sign-on, session management, personal data export and account deletion. |
| **Admin** | People and lecturer approvals, moderation and feedback triage, AI provider and knowledge library, device registry, retention, integrations and audit log. |

The **All tools** screen (`/tools`) lists every feature with an honest status: *Available*, *Pilot*, *Setup required* or *In development*.

## Run it (Windows)

Requires **Node.js 22.13 or newer**. Nothing to install from npm.

```cmd
copy .env.example .env
notepad .env
```

Set `CAMPUS_ADMIN_EMAIL` and a new `CAMPUS_ADMIN_PASSWORD` (12+ characters). Then:

```cmd
node --env-file=.env setup-admin.js
start-windows.bat
```

Open **http://localhost:3100** and sign in.

### Open it on your phone or another computer

While the server window is open, any device on the same Wi-Fi can use Campus OS. The window lists the address under *On your network* (for example `http://192.168.1.20:3100`); the same list is in Admin → *Institution*. The first time, Windows asks whether Node.js may use private networks. Allow it.

This needs `HOST=0.0.0.0` in `.env` (the default in `.env.example`). Browsers only allow the microphone, push notifications and installing the app over HTTPS, so over a plain Wi-Fi address those three are unavailable. For a secure link that also works outside your network, run **`share-online.bat`** (it uses a free Cloudflare quick tunnel; install `cloudflared` first). The link changes each time you start it.

**Upgrading from 0.6:** just start the new version. The database upgrades itself (additive, numbered migrations). A full copy of the previous version is in `backups/v0.6.0-original/`. Run `npm run backup` before major changes.

### Talking to Campus

- **Ask Campus** is in the menu on every screen, or press Ctrl/⌘K and type a question.
- **Full screen:** the expand button in the assistant header, or Ctrl/⌘K → *Ask Campus in full screen*. Esc leaves it.
- **Hey Campus:** turn on *Listen for "Hey Campus"* in Settings → Assistant (or the microphone button in the assistant header). Then say "Hey Campus, …" or just "Campus, …" on any page. Saying only "Campus" opens the assistant and waits for your question. This uses the browser's speech service (Chrome, Edge and Safari) and needs HTTPS or localhost.
- **Animated explanations:** when a picture helps, Campus's eye turns into a small animation, such as a formula, bars, steps or stick figures. You can turn this off in Settings → Assistant, and replay an illustration from the answer it belongs to.

### Turn on the extras

- **AI:** add `AI_GATEWAY_API_KEY` to `.env` and restart. In Admin, open *AI & knowledge*, select *Vercel AI Gateway* and use *Test connection*. Configure `CAMPUS_AI_DEFAULT_MODEL` and `CAMPUS_AI_SUMMARY_MODEL` to change models. See [docs/AI.md](docs/AI.md).
- **University knowledge:** in the same screen, click *Import OTH public pack*. That adds 46 public, source-linked records the assistant can cite. You can also import your own `.jsonl`, `.md` or `.txt` files.
- **Single sign-on:** set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, then register `PUBLIC_URL/auth/sso/callback` with your identity provider.
- **Moodle:** set `MOODLE_URL`. Each user links their own account under Settings → Connections.
- **Push notifications:** these work on `localhost` straight away. Everywhere else they need HTTPS.
- **Classroom hardware:** see [docs/HARDWARE.md](docs/HARDWARE.md). To try it without any hardware, run `node hardware/simulator.js`.

`npm run check` prints what's configured. `npm test` runs the automated tests.

**Vercel hosting:** the current backend needs persistent disk storage and cannot run reliably on Vercel Functions as-is. AI Gateway works independently of where the app is hosted. See the Vercel section in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#vercel-hosting-and-environment-variables).

**Putting it online:** see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). It covers your own network, a temporary HTTPS link from your PC (`share-online.bat`), and a Linux server with automatic HTTPS.

## For developers (and AI agents)

| Doc | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The module map, request flow, conventions, and how to add a feature |
| [docs/AI.md](docs/AI.md) | Providers, prompts, retrieval, personal context, Campus's face and illustrations, and voice |
| [docs/HARDWARE.md](docs/HARDWARE.md) | The device protocol, the activation flow, and reference clients |
| [docs/API.md](docs/API.md) | Every HTTP endpoint |
| [AGENTS.md](AGENTS.md) | Working rules for AI coding agents |
| [docs/GIT.md](docs/GIT.md) | GitHub login, commits, pushes, and the deployment handoff |

```text
server.js            entry point
config/              editions (branding, campus guide) and the feature registry
src/app.js           composition root: services + every module's routes
src/modules/<area>/  one folder per feature (routes.js, optional service.js)
src/ai/              providers, prompts, retrieval, personal context
src/db/              SQLite, numbered migrations, seed
public/js/           ES-module front end (core/, pages/, features/), no build step
public/css/          design tokens → base → components → layout → pages
hardware/            device simulator (Node) and reference client (Python)
tests/               node:test suites
```

## Boundaries

- Never put real student data into an instance without institutional approval, HTTPS, SSO and a retention policy.
- Check-ins, card taps and codes are participation records. They are not proof of identity or presence.
- Understanding ratings are self-reports, and practice sets and career results are aids, not assessments.
- AI answers cite approved sources and tell users to verify time-sensitive information. They are not authoritative.
