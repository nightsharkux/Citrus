# Putting Campus OS online

Campus OS runs on a machine that keeps its `storage/` folder (a SQLite database plus key files), or on Vercel with a hosted Turso database (see below). Static hosting and ordinary PHP web space cannot run it.

| Option | Good for | Effort |
|---|---|---|
| **Your own Wi-Fi** | Phones and laptops in the same room or flat | None. It works while the server window is open |
| **A. Linux VPS + Caddy** (recommended) | A real pilot that people use daily | About an hour, once |
| **B. `share-online.bat` (Cloudflare quick tunnel)** | Showing it to someone for an afternoon, with HTTPS | 5 minutes, but your PC must stay on |

> **Before going public:** use `CAMPUS_EDITION=general` unless OTH Amberg-Weiden has approved the OTH-branded concept. Don't add real student data without the university's approval. A public site run from Germany also needs an *Impressum* and a privacy policy (*Datenschutzerklärung*).

---

## Running on a VPS: what makes it fast

Campus OS is built for one machine with its own disk. On a VPS that is the fast setup:

- **Use the local SQLite file, not Turso.** Every Turso query is an HTTPS round trip that the server waits for, so a page that runs ten queries pays ten network trips. A VPS has a permanent disk, so leave `TURSO_DATABASE_URL` unset, keep `storage/` on the VPS (back it up with `npm run backup`, see `deploy/campusos-backup.timer`) and set `CAMPUS_PERSISTENT_DISK=1` so the storage warning stays off. SQLite runs with WAL, `synchronous=NORMAL`, a 32 MB page cache and memory-mapped reads.
- **Run it as a service behind Caddy**: `deploy/campusos.service` and `deploy/Caddyfile` give automatic HTTPS, HTTP/2 and compression. Set `TRUST_PROXY=1` and `COOKIE_SECURE=1`.
- **Scripts and styles are cached for a year.** The server stamps their URLs with a hash of the files (`/js/app.js?v=…`), so a browser downloads each file once and never asks about it again; a deploy changes the hash and everyone fetches the new files once. Nothing to configure and no build step. Do not add your own caching rules for `/js` or `/css` in the proxy.
- **Logins no longer freeze the server.** Password hashing runs on a worker thread, so a burst of sign-ins does not stall everyone else.
- One process is enough for a faculty. The live updates, rate limiting and long-polling live in that process (see ARCHITECTURE.md, known limits); do not run several copies behind a load balancer.

## Accounts disappear and people must register again

This means the database is not being kept. Campus OS stores everything in a database; on a hosting platform that runs the app as short-lived instances (Vercel, Netlify, Cloud Run, Render's free tier and similar) a local file starts empty after every restart or deploy. The server now says so: the log shows `WARNING: running on <platform> without a hosted database`, the sign-in page shows a notice, and administrators see a banner.

Fix: set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (see the Turso section above) and redeploy. Existing accounts made before that are gone and must be registered once more. Set the encryption keys as secrets too (`CAMPUS_MASTER_KEY`, `CAMPUS_NFC_KEY`), or stored connector tokens become unreadable after a restart. If the app runs on your own machine or a server whose `storage/` folder is on a permanent volume, set `CAMPUS_PERSISTENT_DISK=1` to silence the warning.

## Vercel hosting and environment variables

Vercel Functions have no persistent disk, so the SQLite file cannot live there. Point Campus OS at a hosted [Turso](https://turso.tech) database instead (SQLite in the cloud, so the SQL and migrations are unchanged). Set `TURSO_DATABASE_URL` and the app uses it; leave it unset and the app uses `storage/campusos.db` as before.

**Set up the database**

1. In the Vercel Marketplace, search for **Turso Cloud**, create a database and connect it to the project. Vercel then adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you. Without the integration, create a database at turso.tech and add both variables by hand (`TURSO_DATABASE_URL` looks like `libsql://name-org.turso.io`; store the token as a Secret).
2. Keep the database and the functions in the same region. Every query is a network round trip, and a chat message makes about twenty. `vercel.json` pins the functions to Frankfurt (`fra1`), next to the users; create the Turso database in Frankfurt too, or change `regions` to the database's region (for example `dub1` for Ireland). A response header `X-Vercel-Id: fra1::fra1::…` shows where a request ran.
3. Set `CAMPUS_ADMIN_EMAIL` and `CAMPUS_ADMIN_PASSWORD`, then redeploy. On the first request Campus OS creates its tables and the administrator. Deploying again never repeats this.
4. Optional but recommended: set `CAMPUS_MASTER_KEY` and `CAMPUS_NFC_KEY` as Secrets (each 32 random bytes; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Without them, Campus OS generates the keys once and keeps them in the database's `app_keys` table, which works but puts the key next to the data it protects. Set them before you store Moodle tokens or register devices, because changing a key later makes existing device secrets and Moodle tokens unreadable. Set `CAMPUS_MASTER_KEY` before the first deploy, or keep the generated key from `app_keys`.

Check the connection from your machine with `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run check`.

**How it works.** Queries are sent to Turso over HTTPS by a worker thread while the main thread waits, so the existing synchronous code runs unchanged (`src/db/remote.js`). While a query is in flight that instance handles nothing else, which is fine for a pilot with the database in the same region. Scaling to many users calls for making the data layer asynchronous.

**What does not work on Vercel yet**

- **Meeting recordings.** Audio is stored as files. Uploads return a clear error until object storage is added.
- **Live updates and device long-polling** are held in memory per instance, so a visitor can miss an update that happened on another instance.
- **Rate limits** are per instance.
- **Background clean-up** (expired sessions, recording retention) runs hourly only while an instance is warm.
- **Backups.** `npm run backup` copies a local file. For Turso use `turso db shell <name> .dump` or its point-in-time restore.

Run the tests against the hosted-database code path with `CAMPUS_TEST_DB=turso npm test` (PowerShell: `$env:CAMPUS_TEST_DB='turso'; npm test`). They use a local stand-in for Turso, not a real account.

### AI variables

| Variable | Value | Required? |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Your Vercel AI Gateway key | Required for AI; store as Secret |
| `CAMPUS_AI_DEFAULT_MODEL` | `openai/gpt-6.1-terra/medium` | Optional; shown default |
| `CAMPUS_AI_SUMMARY_MODEL` | `openai/gpt-6-luna/low` | Optional; shown default |
| `CAMPUS_AI_SEARCH_MODEL` | `google/gemini-3.8-flash/low` | Optional; lookups (web, files, university documents); `off` uses the default model |
| `CAMPUS_AI_PROVIDER` | `gateway` | Optional; `gateway` or `off`; saved Admin choice wins |
| `CAMPUS_AI_RATE_PER_MINUTE` | `12` | Optional; per-user request quota, not a spending cap |

Model values use `provider/model/reasoning`. Campus OS sends the model ID and reasoning effort separately to the gateway. Omit the reasoning segment to use the model default; use only a level supported by that model.

These are the only AI environment variables. Do not add direct-provider keys or local model URLs. Complete Vercel AI Gateway billing setup before testing requests; configure any spending budget in the gateway dashboard.

### App variables

| Variable | Value / purpose |
|---|---|
| `CAMPUS_ADMIN_EMAIL` | First administrator's email for a fresh database |
| `CAMPUS_ADMIN_PASSWORD` | New password of 12+ characters; store as Secret. Existing accounts are unchanged. |
| `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` | Set by Vercel itself. Campus OS builds its address from them (production domain in production, the deployment address in previews). Do not add them by hand; enable **Automatically expose System Environment Variables** in the project settings. |
| `CAMPUS_EDITION` | `general` or `oth` |
| `COOKIE_SECURE` | `1` for HTTPS. On by default on Vercel; set it yourself behind your own HTTPS proxy. |
| `TRUST_PROXY` | `1` only when the app is behind your trusted reverse proxy. On by default on Vercel. |
| `HOST`, `PORT` | Bind address and port required by the Node host; see VPS example below |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Hosted database. Required on Vercel; when the URL is set, `DB_PATH` is ignored |
| `CAMPUS_MASTER_KEY`, `CAMPUS_NFC_KEY` | Optional 32-byte keys (64 hex characters or base64). Default: files in `storage/`, or the `app_keys` table on a hosted database |
| `CAMPUS_STORAGE_DIR`, `DB_PATH` | Optional absolute paths on the persistent disk; defaults are `storage/` and `storage/campusos.db` |

When using a custom storage directory, set **both** `CAMPUS_STORAGE_DIR` and `DB_PATH` (for example `/var/lib/campusos` and `/var/lib/campusos/campusos.db`). Preserve the database, audio and keys together across deployments. `OIDC_*`, `MOODLE_URL` and `PUSH_SUBJECT` are optional integrations; leave them unset unless used. No `SESSION_SECRET` variable is required by this code.

### Entering variables in Vercel

1. Open the project, then **Settings > Environment Variables**.
2. Add each variable using its exact name and its raw value. Choose **Secret** for the gateway key and administrator password, and **Config** for model IDs and other non-sensitive settings. Older dashboards may call the secret option **Sensitive** ([Vercel reference](https://vercel.com/docs/environment-variables/sensitive-environment-variables)).
3. Select **Production** for the live project. Configure **Preview** separately if you need test deployments, with its own test credentials and data. Your local `.env` is not automatically copied into the deployment.
4. Save and create a new deployment. Environment changes only apply to new deployments ([Vercel reference](https://vercel.com/docs/environment-variables)).

Keep the key server-side under `AI_GATEWAY_API_KEY`. Never add a public/browser prefix to a secret. Leave platform-managed `PORT` alone when deploying functions; setting it does not turn the function into a persistent server.

---

## On your own network

With `HOST=0.0.0.0` in `.env` (the default), every device on the same Wi-Fi can open Campus OS while it runs. The server window prints the addresses:

```text
  On this computer:   http://localhost:3100
  On your network:    http://192.168.1.20:3100
```

Admin → *Institution* → *Open on other devices* shows the same list with copy buttons. When Windows asks whether Node.js may communicate on private networks, allow it. If a phone can't connect, check that both are on the same network (guest Wi-Fi often isolates devices), and that the Windows network profile is *Private*.

There is no address to configure here. Links such as calendar feeds use whichever address each visitor typed. Over plain `http://` on a network address, browsers turn off the microphone ("Hey Campus", dictation), push notifications and app install. Everything else works. For those features, use option B or a server with HTTPS.

---

## A. Linux VPS (Ubuntu 24.04)

**You need:**
- A VPS with 2 vCPU and 4 GB RAM. An EU provider keeps the data in the EU (GDPR).
- A domain or subdomain, e.g. `campus.example.edu`.

### 1. Point your domain at the server

At your DNS provider, create an **A record**: `campus.example.edu` → your server's IP address. Wait until `ping campus.example.edu` shows that IP.

### 2. Prepare the server

Log in with `ssh root@YOUR_SERVER_IP`, then:

```bash
apt update && apt upgrade -y
# Node.js 26 (the version Campus OS is tested on)
curl -fsSL https://deb.nodesource.com/setup_26.x -o nodesource_setup.sh && bash nodesource_setup.sh && apt install -y nodejs
node --version          # must be 22.13 or newer

apt install -y caddy    # web server with automatic HTTPS

# Firewall: SSH and web only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# A dedicated user with no login shell
useradd --system --create-home --home-dir /opt/campusos --shell /usr/sbin/nologin campusos
```

### 3. Upload the code (from your Windows PC)

In **PowerShell**, inside the `CampusOS_One` folder. Your `.env`, database and backups stay on your PC:

```powershell
tar -czf campusos.tgz --exclude=./storage --exclude=./backups --exclude=./.env --exclude=./node_modules .
scp campusos.tgz root@YOUR_SERVER_IP:/tmp/
```

Then on the server:

```bash
tar -xzf /tmp/campusos.tgz -C /opt/campusos
mkdir -p /opt/campusos/storage /opt/campusos/backups
```

> If you use Git: create a **private** repository and `git clone` it into `/opt/campusos`. `.gitignore` already keeps `.env`, `storage/` and `backups/` out of the repository.

### 4. Configure

```bash
cp /opt/campusos/.env.example /opt/campusos/.env
nano /opt/campusos/.env
```

Set at least:

```ini
CAMPUS_EDITION=general
HOST=127.0.0.1
PORT=3100
TRUST_PROXY=1
COOKIE_SECURE=1
CAMPUS_ADMIN_EMAIL=you@example.edu
CAMPUS_ADMIN_PASSWORD=<a new long password, not the one from your PC>
# AI through Vercel AI Gateway
AI_GATEWAY_API_KEY=<your gateway key>
CAMPUS_AI_DEFAULT_MODEL=openai/gpt-6.1-terra/medium
CAMPUS_AI_SUMMARY_MODEL=openai/gpt-6-luna/low
```

`HOST=127.0.0.1` keeps Campus OS reachable only through Caddy. `TRUST_PROXY=1` lets rate limits see real visitor addresses.

**Option 1 — start fresh:**

```bash
chown -R campusos:campusos /opt/campusos && chmod 600 /opt/campusos/.env
sudo -u campusos node --env-file=/opt/campusos/.env /opt/campusos/setup-admin.js
```

**Option 2 — bring your local data along:**
1. Stop Campus OS on your PC.
2. Upload the whole `storage` folder, including `master.key` and `nfc-hmac.key`: `scp -r storage root@YOUR_SERVER_IP:/opt/campusos/`
3. On the server, run `chown -R campusos:campusos /opt/campusos && chmod 600 /opt/campusos/.env`.

### 5. Run it as a service, with nightly backups

```bash
cp /opt/campusos/deploy/campusos.service /opt/campusos/deploy/campusos-backup.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now campusos campusos-backup.timer
systemctl status campusos        # should say "active (running)"
journalctl -u campusos -f        # live logs (Ctrl+C to leave)
```

### 6. Turn on HTTPS

```bash
cp /opt/campusos/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile        # replace campus.example.edu with your domain
systemctl reload caddy
```

Open `https://campus.example.edu`. Caddy gets the certificate on the first request. Then run `sudo -u campusos node --env-file=/opt/campusos/.env /opt/campusos/scripts/check.js` to confirm the configuration.

### 7. First things to do in the app

- Sign in as admin. Go to **Institution** and decide whether *Open registration* stays on; anyone on the internet can sign up while it's on. Set a recording retention period.
- Under **AI & knowledge**, choose the provider, click *Test connection*, and import your knowledge.
- Push notifications, microphone recording and "install as app" now work on phones, because they need HTTPS.

### Updating to a new version

```powershell
# on your PC
tar -czf campusos.tgz --exclude=./storage --exclude=./backups --exclude=./.env --exclude=./node_modules .
scp campusos.tgz root@YOUR_SERVER_IP:/tmp/
```

```bash
# on the server
sudo -u campusos node --env-file=/opt/campusos/.env /opt/campusos/scripts/backup.js
tar -xzf /tmp/campusos.tgz -C /opt/campusos && chown -R campusos:campusos /opt/campusos
systemctl restart campusos       # database migrations run automatically on start
```

### Backups

Every night `backups/campusos-<date>/` gets a consistent database snapshot, the recordings and the key files. The newest 14 are kept; set `BACKUP_KEEP` to change that. **Also copy them off the server** regularly, for example from your PC:

```powershell
scp -r root@YOUR_SERVER_IP:/opt/campusos/backups ./server-backups
```

To restore: stop the service (`systemctl stop campusos`), copy a backup's files into `/opt/campusos/storage/`, fix ownership with `chown -R campusos:campusos`, and start the service again.

---

## B. Quick demo from your Windows PC (`share-online.bat`)

This gives you a temporary public `https://…trycloudflare.com` address that forwards to Campus OS on your PC. You don't need a server, a domain or any open ports. The address changes every time, and it only works while the window stays open.

1. Install the tunnel once: `winget install --id Cloudflare.cloudflared`
2. Close Campus OS if it is running, then double-click **`share-online.bat`** (or run `npm run share`).

The script starts the tunnel, waits for the address, then starts Campus OS with `COOKIE_SECURE=1` and `TRUST_PROXY=1`. Your `.env` is not changed. Share the link it prints. Ctrl+C stops both. Because the link is HTTPS, voice, push notifications and app install work on phones too.

To do the same by hand: run `cloudflared tunnel --url http://localhost:3100`, then start Campus OS with `COOKIE_SECURE=1` and `TRUST_PROXY=1`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Caddy shows a certificate error | DNS doesn't point at the server yet, or ports 80/443 are blocked. |
| `502 Bad Gateway` | Campus OS isn't running. Check `systemctl status campusos` and `journalctl -u campusos -n 50`. |
| Everything's locked after a few logins | `TRUST_PROXY=1` is missing, so all visitors share one IP. |
| Buttons fail with "Cross-site request rejected" | The proxy changes the `Host` header. Pass it through unchanged (`proxy_set_header Host $host` in nginx; Caddy does this by default). |
| Live updates or AI answers arrive all at once | Your proxy buffers responses. Keep `flush_interval -1` in Caddy; in nginx use `proxy_buffering off`. |
| `node:sqlite` errors on start | Node is older than 22.13. Check `node --version`. |
| A phone on the same Wi-Fi can't connect | `HOST` isn't `0.0.0.0`, Windows Firewall blocked Node.js (allow it on private networks), or the Wi-Fi isolates devices (guest networks). |
| "Port 3100 is already in use" | Campus OS is already running in another window. Close it or set a different `PORT`. |

## Staying signed in, and keeping the database small

- Sessions last 30 days (`SESSION_DAYS`) and slide: every few minutes of activity renews both the database record and the browser cookie, so someone who is using the app is never signed out. The browser also double-checks with the server before it ever shows the sign-in page, so one stray failed request cannot drop anyone.
- Accounts and sessions live in the database. If people are still signed out or lose accounts, the database is being reset by the host: check the persistence warning in the server log and see "Accounts disappear" above.
- Hourly maintenance removes expired sessions, audit lines older than 180 days, read notifications older than 60 days, old device traffic and unused attachment uploads, then compacts the local SQLite file.
- The university documents (.txt) are imported from Admin, AI, Knowledge, Import (the file is split into one entry per PDF page, with file name and page in each), or from the command line: `node --env-file=.env scripts/import-knowledge.js path/to/file.txt`. Importing again updates the entries.
- The first administrator: set `CAMPUS_ADMIN_EMAIL` and `CAMPUS_ADMIN_PASSWORD` (12+ characters) and run `node --env-file=.env setup-admin.js`. It also works to set the two variables for one command only.
