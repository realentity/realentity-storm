# Self-hosting Storm

Storm runs on one machine of yours with Docker: a Linux server, a home server or a VM. It is built to stay **off the
Internet**: the app is reached over a private network or a VPN, and only Telegram and webhooks (if you use them)
come in from outside, through a separate hooks-only site.

```
browser ── HTTPS (you provide) ──► 127.0.0.1:7100  web (Caddy) ─► api ─┐
Telegram, webhooks ── (optional) ─► 127.0.0.1:7101  POST /hooks/* only ─┘   worker ── PostgreSQL (yours)
```

- `web` (Caddy) serves the web app and passes `/api` (REST and the live events WebSocket) to `api`. It is the only
  container with ports, both on `127.0.0.1`: **7100** the app, **7101** the hooks-only site.
- `api` and `worker` (NestJS) use a PostgreSQL of yours (`DATABASE_URL`); `migrate` runs the migrations and the seed
  before they start. The worker runs the pipelines, with a real Chromium for browser steps.
- All of them: read-only file systems, no Linux capabilities, memory limits, `restart: unless-stopped`.
- Nothing is sent without **Act** in the inbox, or a pipeline you saved and switched on.

Everything below goes through [`docker/storm`](../docker/storm), a wrapper around `docker compose` that reads the
repository's `.env`. For development without Docker, see [design.md](design.md) §15.

## Requirements

- Docker with Compose v2, about 4 GB of free memory (the worker may use up to 2 GB with the browser) and 5 GB of disk.
- **PostgreSQL 17 with the `vector` (pgvector) and `citext` extensions.** A native one on the host, a managed one,
  or the container in [`docker/compose.local.yml`](../docker/compose.local.yml) (`STORM_LOCAL=1`).
- A way to reach the app over HTTPS: [Tailscale](https://tailscale.com/) (`tailscale serve`), a reverse proxy with a
  certificate, or a VPN. The live updates and the session cookie need HTTPS outside `localhost`.
- A **Claude API key** (<https://platform.claude.com/settings/keys>) for the LLM steps and the builder.
- Optional: a Telegram bot, an IMAP/SMTP mailbox, Google Calendar, an OpenAI key (embeddings for drafts and topics).

## 1. Database

Create a database and a user that owns it, then the two extensions (they need a superuser; the migrations only check
that they exist):

```bash
sudo -u postgres createuser --pwprompt storm
sudo -u postgres createdb -O storm storm
sudo -u postgres psql -d storm -c 'CREATE EXTENSION IF NOT EXISTS vector;' -c 'CREATE EXTENSION IF NOT EXISTS citext;'
```

The containers reach a PostgreSQL on the host as `host.docker.internal`; allow the Docker networks in `pg_hba.conf`
and `listen_addresses`.

**No PostgreSQL?** Use the container: put `STORM_LOCAL=1` in front of every `./docker/storm` command below (or export
it), and keep `.env.example`'s `DATABASE_URL=postgresql://aime:aime@postgres:5432/aime`. Change its password in
`compose.local.yml` for anything but a test.

## 2. Code and `.env`

```bash
git clone https://github.com/realentity/realentity-storm.git
cd realentity-storm
cp .env.example .env && chmod 600 .env
openssl rand -hex 32          # ENCRYPTION_KEY
```

Set at least (no spaces around `=`):

```
NODE_ENV=production
DATABASE_URL=postgresql://storm:THE_PASSWORD@host.docker.internal:5432/storm
ENCRYPTION_KEY=the 64 characters from openssl
APP_ORIGIN=https://storm.example.com
APP_ADMIN_EMAIL=you@example.com
ANTHROPIC_API_KEY=sk-ant-…
TZ=Europe/London
```

- `ENCRYPTION_KEY` encrypts every stored credential. **Keep a copy outside the server** (a password manager): without
  it no credential opens, also not from a backup.
- `APP_ORIGIN`: exactly the address you open in the browser, without a trailing `/`. The live updates accept only this
  origin.
- `TZ`: your time zone (empty: UTC). Schedules without a `tz` of their own, the morning brief, the weekly review and
  the system jobs follow it.
- The rest of `.env.example` can stay as it is: the containers set `API_HOST`, `API_PORT` and the file folders
  themselves, and the models have defaults (changeable in Settings).

**Files.** Run artifacts (screenshots, traces, downloads) and your documents (CVs, letters that forms attach) live in
`STORM_DATA_DIR` (empty: the repository's `data/`). Both folders must exist and belong to uid 1000; the containers
refuse to start without them, so nothing lands elsewhere if a disk isn't mounted:

```bash
mkdir -p data/artifacts data/documents && sudo chown -R 1000:1000 data     # or under your STORM_DATA_DIR
```

**The login** (one user: a password and an authenticator code). This builds the images the first time (a few
minutes), asks for a password and prints two lines and a QR code:

```bash
./docker/storm run --rm --no-deps api node dist/tools/auth-setup.js
```

Scan the QR code with an authenticator app, and paste both lines into `.env` **as printed**:
`APP_ADMIN_PASSWORD_HASH='$argon2id$…'` keeps its single quotes (without them Compose reads the `$` parts as
variables), and `APP_TOTP_SECRET=…`.

## 3. Start

```bash
./docker/storm up
```

`ps` at the end must show `api` and `worker` **healthy** and `web` **Up**; `migrate` exits after `All migrations have
been successfully applied` (`./docker/storm logs migrate`). `curl -s http://127.0.0.1:7100/api/health` answers
`{"status":"ok","worker":"up"}`.

## 4. HTTPS in front of the app

The app listens on `127.0.0.1:7100` only. Publish it to yourself, not to the Internet:

- **Tailscale:** `sudo tailscale serve --bg --https=8100 7100`; `tailscale serve status` must say `(tailnet only)`.
  `APP_ORIGIN=https://<machine>.<tailnet>.ts.net:8100`.
- **A reverse proxy** (Caddy, nginx, Traefik) on a private network or behind a VPN, with a certificate, forwarding
  everything (WebSockets included) to `127.0.0.1:7100`.

Open `APP_ORIGIN`, sign in. The dot at the top right turns **green** when the live updates are connected.

## 5. Webhooks and Telegram (optional)

Telegram's bot commands and buttons, and pipelines with `trigger: { webhook: … }`, need calls **from the Internet**.
They go to the **hooks-only site** on `127.0.0.1:7101`: it passes `POST /hooks/*` to the api and answers 404 to
everything else, the app included. Each call carries its own secret, which the api checks: Telegram's secret header
and your user id, a webhook's token or HMAC signature (the worker checks the signature), a 64 KB limit, and
throttling.

Make `https://<public host>/hooks/*` reach `127.0.0.1:7101/hooks/*`, by whatever you trust:

- **A tunnel** (Cloudflare Tunnel, Tailscale Funnel, ngrok) pointing at `http://127.0.0.1:7101`.
- **A reverse proxy** on the Internet that forwards only `POST /hooks/` to the hooks site (over a VPN if it runs on
  another machine).
- **A gateway of your own** that checks paths and secrets before forwarding (defence in depth): forward to
  `/hooks/telegram` and `/hooks/<webhook id>` and nothing else.

Then in `.env`:

```
HOOKS_PUBLIC_URL=https://hooks.example.com/hooks   # what callers use: + /<webhook id> (a gateway may map its own prefix)
TELEGRAM_BOT_TOKEN=…                                # a bot of your own from @BotFather
TELEGRAM_CHAT_ID=…                                  # your Telegram user id
TELEGRAM_WEBHOOK_SECRET=…                           # openssl rand -hex 32
```

`./docker/storm up`, then register the bot's webhook once:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://hooks.example.com/hooks/telegram" -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]' -d "max_connections=2" -d "drop_pending_updates=true"
```

`/status` to the bot answers. Without the webhook the bot still **sends** (notifications work), but commands and
buttons don't. Everything the bot does: [telegram.md](telegram.md).

**Webhooks:** a pipeline page creates the address (`HOOKS_PUBLIC_URL/<id>`) and a secret, shown once and rotatable.

| If | Fix |
|---|---|
| The bot is silent though calls arrive | `TELEGRAM_CHAT_ID` isn't your user id: Storm ignores anyone else without a word |
| `404` from `/hooks/telegram` | `TELEGRAM_WEBHOOK_SECRET` differs from the `secret_token` the webhook was registered with |
| A webhook gets `202` but no run starts | the worker's log: `wrong or missing signature` (**New secret** replaced it), or the pipeline isn't enabled |

## 6. Features that need setup

| Feature | What to do |
|---|---|
| **Mail** (`email.*` steps) | `IMAP_HOST`, `SMTP_HOST` (and ports) in `.env`; the address and password (for Gmail an [app password](https://myaccount.google.com/apppasswords)) as a credential named `mail` on **Credentials**, allowed hosts = both servers. Then `./docker/storm check` says it opens |
| **Live browser** (watch and take over browser steps) | `printf 'VNC_PASSWORD=%s\nVNC_VIEW_PASSWORD=%s\n' "$(openssl rand -base64 6)" "$(openssl rand -base64 6)" >> .env`, then `./docker/storm up --force-recreate`. The view goes through the app's `/vnc` (signed in), never a port of its own. [pipelines/live-view-check.yaml](../pipelines/live-view-check.yaml) tests it |
| **Google Calendar** (`calendar.*` steps) | [google-setup.md](google-setup.md): an OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then **Settings → Connect** |
| **Drafts with examples**, topics by meaning | `OPENAI_API_KEY`: embeds the emails you replied to, so new drafts get your most similar approved replies as examples; and your topics' document passages and facts, so a draft gets the ones closest to the email in meaning, in any language ([topics.md](topics.md)). That text then also goes to OpenAI. Without it, examples are left out and topics match by words |
| **Documents** (forms attach a CV) | **Profile → Documents**; they live in `STORM_DATA_DIR/documents` |
| **Health reports** | below |

**First pipelines:** **Apps → Examples** installs ready-made ones (each with a checklist of what it needs); or
**Pipelines → New pipeline** and paste one from [pipelines/](../pipelines), **Check**, **Dry run**, **Save**, then switch
it on. The builder (describe what you want) makes new ones.

| If | Fix |
|---|---|
| `migrate` fails with `permission denied to create extension` | the extensions in step 1, as the superuser |
| `migrate` fails with `P1001` / `Can't reach database server` | the `DATABASE_URL` host (`host.docker.internal` for the host's PostgreSQL) and `pg_hba.conf` |
| `bind source path does not exist` | create `artifacts/` and `documents/` under `STORM_DATA_DIR` (step 2) |
| `api` restarts, log says `Invalid environment (.env)` | the listed key; the error names keys, never values |
| Login says the password or code is wrong although it is right | `APP_ADMIN_PASSWORD_HASH` lost its single quotes; fix `.env`, `./docker/storm up` |
| The dot stays red | `APP_ORIGIN` must be exactly the address in the browser |
| `EACCES` under `/data/artifacts` or `/data/documents` | the folders must belong to uid 1000 |
| A run's mail step fails with `AUTHENTICATIONFAILED` | the credential's secret (an app password for Gmail) and its allowed hosts |
| A `fetch` step: `resolves to a private or local address` | by design: `http.fetch` never reads the LAN, the tailnet or the host |

## 7. Updates

```bash
git pull --ff-only && ./docker/storm up && ./docker/storm check
```

- Before an update with database changes, a dump of the moment: `pg_dump -Fc -f before-update.dump <database>`.
- A run in progress continues after the restart: the interrupted step runs again (an interrupted LLM call is paid
  twice). An interrupted **send** is never repeated: it fails and shows on the run.
- After a `.env` change: `./docker/storm up --force-recreate`.

## 8. Backups and restore

- **Database:** a nightly `pg_dump -Fc` of the database, named `<database>-YYYY-MM-DD.dump`, in a folder you also copy
  off the machine.
- **Files:** `.env`, and `STORM_DATA_DIR/documents`. The artifacts are working files (deleted after
  `ARTIFACTS_RETENTION_DAYS`); the runs themselves are in the database.
- **`ENCRYPTION_KEY`:** a backup with `.env` holds the key next to the data; treat it as sensitive. Keep the key's own
  copy elsewhere: it is what restores the credentials on a new machine.

### Restore test

For a PostgreSQL on the same host (it uses `sudo -u postgres`), with `STORM_DUMPS` (the dump folder) in `.env`:

```bash
sudo ./docker/storm restore-test            # or: ... restore-test /path/to/<database>-YYYY-MM-DD.dump
```

It restores the newest dump into `storm_restore_test`, compares the counts with the live database, opens every
credential with the key in `.env`, drops the test database, and reports the result (below; or to Telegram). It fails
when the restore fails, a table is missing or empty, a credential doesn't open, or the newest dump is more than 2 days
old. Run it monthly from a systemd timer or cron.

### Real restore

```bash
./docker/storm stop
sudo -u postgres dropdb --if-exists --force storm && sudo -u postgres createdb -O storm storm
sudo -u postgres psql -d storm -c 'CREATE EXTENSION vector;' -c 'CREATE EXTENSION citext;'
sudo cat /path/to/storm-YYYY-MM-DD.dump | sudo -u postgres pg_restore -d storm --no-owner --no-comments --role=storm --exit-on-error
./docker/storm up && ./docker/storm check
```

`ENCRYPTION_KEY` must be the one from when the dump was made. The migrations bring an older dump up to date on `up`.

### Health reports

The host's own jobs (the backup, the restore test, a disk check) can report to Storm, which shows them on the
**Health** page and alerts on Telegram once per problem, and when a report stops coming:

```bash
echo "HEALTH_REPORT_TOKEN=$(openssl rand -hex 32)" >> .env && ./docker/storm up
# from a job on the host:
curl -s -X POST -H "x-storm-health-token: $HEALTH_REPORT_TOKEN" -H 'content-type: application/json' \
  --data '{"name":"backup","ok":true,"detail":"storm-2026-11-08.dump, 41 MB","maxAgeHours":26}' \
  http://127.0.0.1:7101/hooks/health
```

`maxAgeHours`: how long until a missing report counts as a problem. A wrong token gets a 404.

## Checks

| Check | How | Expected |
|---|---|---|
| Running | `./docker/storm ps`; `curl -s http://127.0.0.1:7100/api/health` | `api`, `worker` healthy; `{"status":"ok","worker":"up"}` |
| No open ports | `sudo ss -tlnp \| grep -E ':7100\|:7101'`; from another machine, `nmap -Pn -p 7100,7101 <host>` | both only on `127.0.0.1`; closed from outside |
| Restart mid-run | start a run with an LLM step, `./docker/storm restart worker` while it runs | the run continues and ends *done* |
| Worker alert | `./docker/storm stop worker`, wait 4 minutes, `./docker/storm start worker` | Telegram: "the worker is down", then "the worker is back" |

## Logs

`./docker/storm logs -f --tail 100 worker` (or `api`, `web`, `migrate`). Email text, payloads and secrets are never
logged.
