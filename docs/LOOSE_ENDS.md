# Loose ends

What is still open after moving to Vercel, Turso and the AI Gateway, and roughly what each needs. See `DEPLOYMENT.md` for setup details.

## Before relying on the hosted site

| Item | What to do |
|---|---|
| Hosted database not tested against a real account | Run `npm run check` with the real `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Then sign in on the deployed site. |
| AI not tested against a real gateway | Set up AI Gateway billing, add `AI_GATEWAY_API_KEY`, redeploy, then send one message in the assistant. |
| Model slugs unconfirmed | Check `CAMPUS_AI_DEFAULT_MODEL` and `CAMPUS_AI_SUMMARY_MODEL` exist in the gateway. A wrong slug only fails on the first request. |
| Encryption keys | Set `CAMPUS_MASTER_KEY` and `CAMPUS_NFC_KEY` as Secrets before the first real deploy. Changing them later breaks stored Moodle tokens and device secrets. |
| Admin account | Set `CAMPUS_ADMIN_EMAIL` and `CAMPUS_ADMIN_PASSWORD`, then redeploy. |
| Backups | `npm run backup` does not cover Turso. Schedule `turso db shell <name> .dump`, or confirm point-in-time restore is on. |

## File storage

Recordings are the only files the app writes, and they need a disk. On Vercel, uploads currently return an error.

- Add an object store (Vercel Blob, or any S3-compatible bucket such as Cloudflare R2).
- Put it behind one small storage service in `src/services/` so the recordings module doesn't care where bytes live. Local disk stays the default.
- Rule 1 allows no new runtime dependencies, so use the store's HTTP API with `fetch` and `node:crypto` (S3 request signing), or agree an exception first.
- Keep recordings private: serve them through an authenticated route, never a public URL. Retention clean-up must delete from the bucket too.
- Add tests for the access-denied case and for the retention delete.

## Limits of running on Vercel

| Gap | Rough fix |
|---|---|
| Live updates and device long-polling are per instance | Move event fan-out to a shared store (a Turso table polled briefly, or a hosted pub/sub). Or run on a VPS. |
| Rate limits are per instance | Count in the database instead of memory. |
| Hourly clean-up only runs while an instance is warm | Add a Vercel Cron job that calls a protected clean-up endpoint. |
| Each query blocks its instance | Fine for a pilot. For scale, make the data layer asynchronous. |

If NFC readers and classroom pucks matter soon, the VPS option in `DEPLOYMENT.md` avoids most of this table.

## Natural voices and web search

Both run through the AI Gateway and are tested against a stand-in, not the real gateway yet.

| Item | What to do |
|---|---|
| Natural voices | Text to speech is in beta on the gateway. In Settings → Assistant → Voice, play a sample of a natural voice. If browsers keep using their own voices, the gateway is refusing speech for the account (see the server log line `Campus OS speech status`): request access in Vercel or set `CAMPUS_AI_SPEECH_MODEL` to a model you can use. |
| Voice choice | Listen to the voices with real answers in German and English. Gemini (`google/gemini-3.8-flash-tts`) is the most expressive and gets spoken directions; Microsoft (`microsoft/mai-voice-2.1-flash`) has the lowest delay and a native German voice. |
| Web search | Ask something current ("what happened in the news today?") and check that the answer links real pages. If the log shows `web search refused`, Perplexity search is not enabled for the gateway account. |
| Cost | Watch gateway spending for a week: speech is billed per character and searches at about $5 per 1,000. Admin → AI & knowledge → Tools turns either off. |

## Voice conversation

The turn-taking rules have automated tests. The browser parts (microphone, speech, echo) can only be checked by hand.

| Item | What to do |
|---|---|
| Real devices | Hold a conversation in Chrome or Edge on Windows through laptop speakers (not headphones), in Safari on an iPhone and in Chrome on Android. Check that Campus does not cut itself off, that a spoken "wait" stops it, and that a question asked right after it stops is heard. |
| Echo through loud speakers | If Campus still interrupts itself, raise the thresholds in `isInterruption` (`public/js/features/turns.js`). Headphones avoid echo entirely. |
| On-device speech | Chrome and Edge send audio to their speech service. For a privacy-first deployment, replace `Recognition` in `voice.js` with an on-device engine. |

## Classroom, meetings and documents

These are tested against a stand-in gateway, not the real one yet.

| Item | What to do |
|---|---|
| PDFs sent to the model | Upload one of the PDFs whose text cannot be decoded (for example the SPO for Industrial Engineering) in *Documents* and check that its pages come back. If the gateway refuses the `file` part for the lookup model, set `CAMPUS_AI_SEARCH_MODEL` to a model that accepts PDFs, or export the pages as pictures. |
| Request size on Vercel | Vercel functions accept about 4.5 MB per request, so uploads larger than about 3 MB fail there although the app allows 10 MB. Move uploads to object storage (see *File storage*) or run on a server. |
| Reading on Vercel | A document is read a few pages per request while the *Documents* page is open. Leaving pauses it; coming back resumes it. A background job would remove that need. |
| "Hit Campus" | Try it on a real microphone in German and English. If false wakes happen, remove the word from `MISHEARD` in `features/wake-phrase.js`; if a mishearing is missing, add it there and to the tests. |
| Transcript retention | Kept lecture transcripts stay until the lecturer deletes them. Add them to the retention clean-up once the university sets a period. |

## Planned features

Each is marked `planned` in `config/capabilities.js` and shows as *In development*.

- Audio transcription (needs file storage first, plus a transcription service through `deps.ai`)
- German interface
- Native iOS and Android apps
- Nearby lecture discovery and projector control
- Validated mastery modelling (needs evaluation data)

## Before going public

- Imprint (*Impressum*) and privacy policy (*Datenschutzerklärung*) for a site run from Germany.
- GDPR and security review with the university's data-protection office.
- Written approval from OTH Amberg-Weiden before using `CAMPUS_EDITION=oth`. Use `general` until then.
- No real student data until the university agrees.

## Housekeeping

- `docs/CHANGELOG.md` still mentions `PUBLIC_URL` and has two `### Added` sections under 1.1.0.
- `.env.example` has an uncommitted edit: restore the model-slug comments and give the Turso variables a heading.
