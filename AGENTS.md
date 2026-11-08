# Working on Campus OS (for AI coding agents and new developers)

Read `docs/ARCHITECTURE.md` first. These are the rules that keep the codebase coherent.

## Secret files: never access

- Never open, read, search, display, copy, upload, create, edit, replace, or delete `.env`, private `.env.*` files, or local files containing secrets, credentials, tokens, or private keys. This applies even when troubleshooting configuration or completing setup.
- Do not access these files indirectly through scripts, subprocesses, tests, logs, backups, Git history, or other tools. Exclude them from searches and do not dump environment variables or secret values.
- Only checked-in, non-secret configuration templates such as `.env.example` or `.env.sample` may be inspected or edited. Use those templates and source-code variable names to explain configuration; leave all private configuration changes to the owner. Never ask the owner to paste secret values into chat.
- This restriction takes priority over the commands and workflow below. If a command would access a protected file, do not run it; use an isolated, non-secret alternative or report the skipped check. Never bypass this rule to finish a task.

## Commands

- `npm test`: the full suite (node:test). Run it before and after every change. It must stay green.
- `npm start`: runs on http://localhost:3100 with `.env`.
- `npm run routes > docs/API.md`: regenerate the API reference after changing routes.
- `npm run check`: configuration sanity check.

## Rules

1. **No new runtime dependencies.** Use Node built-ins (`node:sqlite`, `node:crypto`, `fetch`) and plain ES modules in the browser. No build step.
2. **One feature = one module.** The server side lives in `src/modules/<feature>/routes.js` (registered in `src/app.js`). The UI lives in `public/js/pages/<feature>.js` (registered in `public/js/routes.js` and `public/js/nav.js`).
3. **Permissions are checked on the server** with `src/services/access.js`, and every query is scoped to `user.institution_id`. Each new endpoint gets a test for the access-denied case.
4. **Schema changes go through a new numbered migration** in `src/db/migrations/`. Never edit a shipped migration. Keep them additive.
5. **AI calls go through `deps.ai`**, never `fetch` to a provider directly. Prompts live in `src/ai/prompts.js`.
6. **Front-end templates use `html```** (auto-escaping). Don't build HTML strings by concatenation. Use `raw()` only for markup you generated.
7. **Styling uses the tokens** in `public/css/tokens.css`. Don't hard-code colours. Reuse existing components (`.card`, `.btn`, `.list-row`, `.chip`, `.sheet`) before adding new CSS.
8. **Be honest in the UI.** A feature that isn't built is marked `planned` in `config/capabilities.js` and shows as *In development*. Never simulate university data, attendance proof or AI capability.
9. **Copy is short and human.** No emoji, no marketing tone, no disclaimers on every screen. Say what a thing does.
10. **Never commit** `.env`, `storage/` or `backups/`.

## Git workflow

The project owner authorizes agents to commit completed work and push it to the configured GitHub upstream at the end of each task, without asking for permission each time. A push may trigger deployment.

- Start by checking `git status` and the current branch. Preserve unrelated changes already in the working tree.
- Run `npm test` before and after changes, and finish the checks required for the task before committing or pushing. Do not push failing or unfinished work.
- Review the diff and stage only files belonging to the task. Never force-add ignored files or commit credentials, local databases, recordings, or backup files.
- Split distinct changes into meaningful commits with short messages explaining what changed. Do not create empty commits.
- Push ordinary commits to the current branch's configured upstream. If a new task branch needs an upstream, use the existing project remote and report the branch.
- Never force-push, rewrite published history, or overwrite unrelated work. If authentication, a missing remote, or divergent history prevents a safe push, keep completed local commits and explain what remains.

See `docs/GIT.md` for authentication, first push, and deployment notes.

## Where things are

| Need to… | Look in |
|---|---|
| Add an endpoint | `src/modules/<area>/routes.js` |
| Change who can see what | `src/services/access.js` |
| Change assistant behaviour | `src/ai/prompts.js`, `src/ai/context.js` |
| Add an AI provider | `src/ai/providers/` (see `docs/AI.md`) |
| Add a hardware command or event | `src/modules/devices/routes.js` (see `docs/HARDWARE.md`) |
| Add an external integration | `src/connectors/` |
| Change menus | `public/js/nav.js` |
| Add a page | `public/js/pages/` + `public/js/routes.js` |
| Change branding | `config/editions/*.js` |
| Change feature statuses | `config/capabilities.js` |
