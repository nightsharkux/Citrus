# Putting Campus OS online

Campus OS needs a machine that runs Node.js continuously and keeps its `storage/` folder (a SQLite database plus key files). That rules out serverless hosts (Vercel, Netlify), static hosting, and ordinary PHP web space.

| Option | Good for | Effort |
|---|---|---|
| **Your own Wi-Fi** | Phones and laptops in the same room or flat | None. It works while the server window is open |
| **A. Linux VPS + Caddy** (recommended) | A real pilot that people use daily | About an hour, once |
| **B. `share-online.bat` (Cloudflare quick tunnel)** | Showing it to someone for an afternoon, with HTTPS | 5 minutes, but your PC must stay on |

> **Before going public:** use `CAMPUS_EDITION=general` unless OTH Amberg-Weiden has approved the OTH-branded concept. Don't add real student data without the university's approval. A public site run from Germany also needs an *Impressum* and a privacy policy (*Datenschutzerklärung*).

---

## Vercel hosting and environment variables

**The current backend needs a persistent disk and a long-running Node process. It is not ready for Vercel Functions.** SQLite, meeting audio, the connector encryption key, the NFC HMAC key and Web Push keys live on disk. Vercel Functions have ephemeral storage that is not shared across instances ([Vercel's SQLite guidance](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)). Moving `DB_PATH` to `/tmp` does not provide durability. There is no `DATABASE_URL` integration in this app.

For the existing code, run `npm start` on a persistent Node server using the VPS steps below. Vercel AI Gateway works from that server. Hosting the backend on Vercel requires separate work: an external durable database, object storage, persistent secret handling, and changes to background maintenance, rate limits and real-time delivery. Deploying just `public/` also omits the server APIs and server-rendered configuration.

### AI variables

| Variable | Value | Required? |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Your Vercel AI Gateway key | Required for AI; store as Secret |
| `CAMPUS_AI_MODEL` | `openai/gpt-6.1-terra` | Optional; shown default |
| `CAMPUS_AI_SUMMARY_MODEL` | `google/gemini-2.5-flash-lite` | Optional; shown default |
| `CAMPUS_AI_PROVIDER` | `gateway` | Optional; `gateway` or `off`; saved Admin choice wins |
| `CAMPUS_AI_RATE_PER_MINUTE` | `12` | Optional; per-user request quota, not a spending cap |

These are the only AI environment variables. Do not add direct-provider keys or local model URLs. Complete Vercel AI Gateway billing setup before testing requests; configure any spending budget in the gateway dashboard.

### App variables on the backend host

| Variable | Value / purpose |
|---|---|
| `CAMPUS_ADMIN_EMAIL` | First administrator's email for a fresh database |
| `CAMPUS_ADMIN_PASSWORD` | New password of 12+ characters; store as Secret. Existing accounts are unchanged. |
| `PUBLIC_URL` | Final HTTPS address people use, e.g. `https://campus.example.edu` |
| `CAMPUS_EDITION` | `general` or `oth` |
| `COOKIE_SECURE` | `1` for HTTPS; defaults on when unset and `PUBLIC_URL` is HTTPS |
| `TRUST_PROXY` | `1` only when the app is behind your trusted reverse proxy |
| `HOST`, `PORT` | Bind address and port required by the Node host; see VPS example below |
| `CAMPUS_STORAGE_DIR`, `DB_PATH` | Optional absolute paths on the persistent disk; defaults are `storage/` and `storage/campusos.db` |

When using a custom storage directory, set **both** `CAMPUS_STORAGE_DIR` and `DB_PATH` (for example `/var/lib/campusos` and `/var/lib/campusos/campusos.db`). Preserve the database, audio and keys together across deployments. `OIDC_*`, `MOODLE_URL` and `PUSH_SUBJECT` are optional integrations; leave them unset unless used. No `SESSION_SECRET` variable is required by this code.

### Entering variables in Vercel

These steps configure a Vercel project; they do not resolve the backend hosting requirements above.

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

Leave `PUBLIC_URL` empty here. Links such as calendar feeds then use whichever address each visitor typed. Over plain `http://` on a network address, browsers turn off the microphone ("Hey Campus", dictation), push notifications and app install. Everything else works. For those features, use option B or a server with HTTPS.

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
PUBLIC_URL=https://campus.example.edu
HOST=127.0.0.1
PORT=3100
TRUST_PROXY=1
CAMPUS_ADMIN_EMAIL=you@example.edu
CAMPUS_ADMIN_PASSWORD=<a new long password, not the one from your PC>
# AI through Vercel AI Gateway
AI_GATEWAY_API_KEY=<your gateway key>
CAMPUS_AI_MODEL=openai/gpt-6.1-terra
CAMPUS_AI_SUMMARY_MODEL=google/gemini-2.5-flash-lite
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

The script starts the tunnel, waits for the address, then starts Campus OS with that address as `PUBLIC_URL` and `TRUST_PROXY=1`. Your `.env` is not changed. Share the link it prints. Ctrl+C stops both. Because the link is HTTPS, voice, push notifications and app install work on phones too.

To do the same by hand: run `cloudflared tunnel --url http://localhost:3100`, then start Campus OS with `PUBLIC_URL` set to the printed address and `TRUST_PROXY=1`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Caddy shows a certificate error | DNS doesn't point at the server yet, or ports 80/443 are blocked. |
| `502 Bad Gateway` | Campus OS isn't running. Check `systemctl status campusos` and `journalctl -u campusos -n 50`. |
| Everything's locked after a few logins | `TRUST_PROXY=1` is missing, so all visitors share one IP. |
| Buttons fail with "Cross-site request rejected" | `PUBLIC_URL` doesn't exactly match the address in the browser. |
| Live updates or AI answers arrive all at once | Your proxy buffers responses. Keep `flush_interval -1` in Caddy; in nginx use `proxy_buffering off`. |
| `node:sqlite` errors on start | Node is older than 22.13. Check `node --version`. |
| A phone on the same Wi-Fi can't connect | `HOST` isn't `0.0.0.0`, Windows Firewall blocked Node.js (allow it on private networks), or the Wi-Fi isolates devices (guest networks). |
| "Port 3100 is already in use" | Campus OS is already running in another window. Close it or set a different `PORT`. |
