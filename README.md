# RealEntity Storm

<img src="apps/web/public/logo.svg" alt="" width="64" height="64">

**Storm** for short; part of [RealEntity](https://github.com/realentity).

**Your own automation agent, on your own server.** Tell Storm in a chat what you want taken care of: "keep my bills
and remind me before they're due", "find jobs that fit my CV and help me apply", "tell me when this laptop drops below
€900". Storm builds it: the pipelines that do the work, the data they keep, and the pages where you follow and manage
it. It reads your email, watches websites, feeds and APIs, works real web pages in a browser you can watch, and
prepares replies, form entries, uploads and calendar events. **Nothing leaves the system until you have seen exactly
what will be sent and pressed Act.** It learns from how you edit what it proposes.

Single user. Runs with Docker on a machine of yours, reached over your private network, not the Internet.

## What it can do

### A job search, end to end

The Job Search App shows what Storm is for: work that spans several sites, your mailbox and your calendar, lasts for
weeks, and needs you only at the moments that matter.

1. **Teach it a job board once.** Open the board in the live browser and bring it to the list of postings. Storm
   proposes a recipe for reading it, outlines the items it would take on the page, and saves the recipe when you
   confirm. Do this for as many boards as you like.
2. **Every morning it reads all of them** without the LLM, page after page. It drops postings it has already seen
   and scores the new ones against your profile. The scores are **calibrated on what happened to your past
   applications**: interviews, rejections, silence.
3. **You get a shortlist**, best first, each with the reason for its score. You pick the ones worth applying to.
4. **It prepares each application.** It opens the posting's form (following its Apply button), reads every field,
   fills them from your profile, writes the free-text answers and attaches your CV. A question it can't answer
   ("notice period?") comes to you, and **your answer is remembered for the next form**. You see every field and
   file before **Act**. Before typing, it reads the form again and stops if anything changed.
5. **It keeps track.** A week later it reminds you to follow up, **unless the employer answered first**. Employers'
   emails move each job on to *responded*, *interview* or *rejected*. An invitation to an interview becomes a
   proposed calendar event, with prep notes and a warning if something else is on at that time.
6. **When a board changes its layout**, the recipe stops matching. A browser agent finds the list on the new page,
   proposes a corrected recipe for you to approve, and the run carries on with it.

### Apps: describe one, and Storm builds it

An **App** is a small personal application: data types, list and detail pages, stages, forms, buttons, and the
pipelines that fill them. Say "I'm looking for a job" or "keep my bills" and the builder proposes the whole App, with
its pipelines, as one change for you to review. It starts each type from the schema.org type that means the same,
then dry-runs the source and fits the type to the data the source really returns. Later, "add a rating to jobs"
shows what changes in the App and in each of its pipelines.

Apps are typed and versioned, so they keep working as they grow:

- A pipeline that writes a field its type doesn't have is refused when you save it, not discovered later on a page.
- Stages say who may move an entity where: a pipeline can mark a job *applied*, never move it back.
- Fields you own are never overwritten by a pipeline.
- A change to an App that would break one of its pipelines is refused, naming the pipeline.
- A change to an entity can start another pipeline: a job reaching *interview*, a price falling, a bill arriving.

Ready-made Apps install from **Apps → Examples**: Job Search, Bills, Prices, Releases, Tables, Trips, Clients, Apartments, Orders, Subscriptions, Car and Server ops.

### More of what it handles

- **Bills from PDFs.** Bills arrive by email, often only as a PDF attachment. Storm reads issuer, amount, due date,
  period and reference from the email and the PDF. It keeps one record per bill (seeing the same bill again updates
  it) and puts a reminder in your calendar a few days before it's due. It warns you when an amount is well above that
  issuer's usual one.
- **Replies that sound like you.** It drafts replies to recruiters or clients using your most similar replies that
  you approved before as examples. Every edit you make becomes another example, and a nightly review of your edits
  suggests rules and pipeline changes for you to accept.
- **Nobody answered.** It finds emails you sent that got no reply and drafts a follow-up for you to approve.
- **Sites without an API.** Sign in to a site with a stored credential, read a page, download a statement, upload a
  document, or let an agent fill in an unfamiliar form. The agent can only fill: Storm records what it did, shows you
  every action, and repeats them exactly, without the LLM, only after you press **Act**.
- **Your own systems.** Read JSON APIs with a key, change things at an API after you approve the request, react to
  webhooks signed GitHub-style, and watch a PostgreSQL database read-only. For example, Storm can alert you when a
  table grows faster than usual, or propose a GitHub issue when one of its own pipelines fails.

Each one is a pipeline you can read: [docs/capabilities.md](docs/capabilities.md#5-putting-it-together) lists them
with their steps, and [pipelines/](pipelines) has them ready to paste.

## How it works

1. **You describe it** in the builder chat, in the app or on Telegram.
2. **Storm compiles it** into a pipeline made only of steps from a fixed catalog of over 40 step types: mail, browser,
   HTTP and RSS, LLM, data, database, calendar, documents, Telegram, timers and approval gates. The LLM can combine
   these steps but can't add new ones or write code. The compiler checks every reference, domain and recipient before
   a pipeline can be saved. You can read and edit the YAML or use the visual editor, and dry-run it before switching
   it on.
3. **It runs** on a schedule, on new email, from a webhook, when an App's data changes, or when you press a button.
4. **It proposes, you act.** Every side effect (an email, a form submission, an upload, a calendar invite, an API
   call) waits behind a gate that shows exactly what will go out. Edit it if needed, then press **Act** in the app or
   on Telegram.
5. **It learns.** Your edits and rejections become examples for future drafts, and a nightly reflection suggests rules
   and pipeline changes for you to accept or reject.

## How it learns from you

Storm doesn't fine-tune a model. It keeps what it learns from you as data you can see, edit and switch off:

- **Every decision is recorded.** For each proposal, Storm keeps what it proposed, what you sent, the difference, and
  whether you approved, edited or rejected it.
- **Your approved texts become examples.** A reply or text you approve is kept with what it answered. The next draft
  of the same kind gets your three most similar approved texts as examples, for tone, length and structure, never for
  facts. This needs `OPENAI_API_KEY` for the embeddings.
- **Your edits become rules.** Every night, a review of your edits and rejections suggests rules, such as "shorten
  recruiter replies" or "drop the opening pleasantries". A suggestion does nothing until you approve or edit it on the
  **Rules** page. From then on it goes into every LLM step it applies to.
- **Your pipelines improve.** The same review can suggest a change to a pipeline, such as a tighter filter or a
  different threshold. The builder turns it into a change for you to approve.
- **Your answers become facts.** A question it asked you while filling a form ("notice period?", "work permit?") is
  answered once and kept on your **Profile**, for every form after it.
- **Outcomes calibrate its judgement.** Scores for job postings take into account what happened to your past
  applications: which ones led to interviews, which were rejected, and which got no answer.
- **Broken site readers are repaired with you.** When a site changes, Storm proposes a fixed recipe for reading it, and
  saves it once you approve.

## Why you can give it your accounts

- **Nothing goes out without Act.** The compiler inserts a gate before every side effect, even if you didn't write one.
- **Untrusted input is data.** Emails, pages and downloads never trigger actions. Recipients, guests and form
  addresses come from real data or from the pipeline, never from LLM text.
- **Secrets never reach the LLM.** Credentials are encrypted in PostgreSQL (envelope encryption, the key in `.env`);
  the LLM sees only references like `{{cred:mail}}`, and only the browser login receives the real value.
- **Limits you set.** Allowed domains per pipeline, rate limits per step type, a monthly LLM budget, a kill switch.
  Private and VPN addresses are never fetched.
- **A browser you can watch and take over.** Browser steps run in a real Chromium, visible live in the app. CAPTCHAs,
  2FA and odd dialogs are handed to you; you click and type on the site, then continue.
- **Everything recorded.** Each run keeps its pipeline version, steps, inputs, outputs, screenshots and traces.

## Before you start

| What | For | |
|---|---|---|
| **Docker** with Compose v2, about 4 GB of free memory and 5 GB of disk | Running Storm (Linux, macOS, or Windows with WSL) | Required |
| **A Claude API key** ([platform.claude.com](https://platform.claude.com/settings/keys)) | The builder and every LLM step: triage, scoring, drafts, summaries. Paid per use; set a monthly budget in Settings or `.env` | Required |
| **PostgreSQL 17** with the `vector` (pgvector) and `citext` extensions | Storm's data. A bundled container works for trying it out | Required (bundled) |
| **An authenticator app** | The login: a password and a one-time code | Required |
| **A way to reach it over HTTPS**: Tailscale, a reverse proxy, or a VPN | Using it from other devices. Not needed on `localhost` | On a server |
| **A mailbox** with IMAP and SMTP (for Gmail, an app password) | The email steps | Optional |
| **A Telegram bot** of your own, from @BotFather | Approvals and notifications on your phone. Commands and buttons also need a public address for webhooks | Optional |
| **A Google Cloud OAuth client** | Google Calendar steps | Optional |
| **An OpenAI API key** | Past replies as examples in new drafts (embeddings). The email text then also goes to OpenAI | Optional |

## Setup

### Try it on your machine

Only Docker is needed: `STORM_LOCAL=1` in the commands below starts PostgreSQL in a container next to Storm, so there
is no database to install or create. The app opens at `http://localhost:7100`. The commands are Bash: on Windows, run
them in WSL.

```bash
git clone https://github.com/realentity/realentity-storm.git
cd realentity-storm
cp .env.example .env && chmod 600 .env
openssl rand -hex 32                                   # your ENCRYPTION_KEY
```

Set these in `.env` (no spaces around `=`):

```
ENCRYPTION_KEY=<the 64 characters from openssl>
ANTHROPIC_API_KEY=<your Claude API key>
APP_ORIGIN=http://localhost:7100
TZ=Europe/London
```

The keys are already in the file: change their values, don't add second lines. `APP_ORIGIN` is the address you open
(7100 is `STORM_PORT`'s default). `DATABASE_URL` already points at the PostgreSQL container (`postgres` is its name on
the Docker network): leave it as it is.

**The login, before the first start.** Storm has one user, who signs in with a password and a 6-digit code from an
authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …). Both live in `.env`, so they have to
be there before Storm starts.

1. Make the folders for run files and your documents:

   ```bash
   mkdir -p data/artifacts data/documents && sudo chown -R 1000:1000 data
   ```

2. Run the login setup. The first time, this builds the images (a few minutes). It asks for a password (at least 12
   characters, not shown as you type) and prints a QR code and two lines:

   ```bash
   STORM_LOCAL=1 ./docker/storm run --rm --no-deps api node dist/tools/auth-setup.js
   ```

   ```text
   APP_ADMIN_PASSWORD_HASH='$argon2id$v=19$…'
   APP_TOTP_SECRET=<32 capital letters and digits>
   ```

3. Scan the QR code with your authenticator app (or type in the secret it prints). Storm now appears in the app with
   a code that changes every 30 seconds.

4. Put the two lines into `.env` in place of the empty `APP_ADMIN_PASSWORD_HASH=` and `APP_TOTP_SECRET=`, exactly as
   printed: the single quotes keep the `$` signs. Nothing is written for you, and the password itself is stored
   nowhere, only its hash.

5. Start Storm:

   ```bash
   STORM_LOCAL=1 ./docker/storm up
   ```

6. Open `http://localhost:7100` and sign in with the password and the current code from the app.

**Apps → Examples** installs ready-made Apps and pipelines, each with a checklist of what it still needs. The
**Builder** makes new ones from a description.

Changed `.env` later? `STORM_LOCAL=1 ./docker/storm up` again applies it. A new password or authenticator: run step 2
again and replace both lines.

### Run it on a server

[docs/self-hosting.md](docs/self-hosting.md): your own PostgreSQL, HTTPS in front, Telegram and webhooks, mail,
Calendar, updates, backups and the restore test.

### Develop

```bash
# Node 22.12+ or 24, pnpm 10, Docker
pnpm install
cp .env.example .env                                   # then set ENCRYPTION_KEY, ANTHROPIC_API_KEY and
                                                       # DATABASE_URL to the localhost line above it
docker compose -f docker/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm auth:setup                                        # the login: password + authenticator code, into .env
pnpm --filter @realentity/storm-worker exec playwright install chromium
pnpm dev                                               # api, worker and web
```

Tests: `pnpm test` (unit), `pnpm test:e2e` (integration, PostgreSQL in Testcontainers), `pnpm test:web` (browser
tests with Playwright).

### `.env` at a glance

One `.env` in the repository root, shared by every part. [.env.example](.env.example) explains each key; Storm refuses
to start with an invalid value and names the key, never the value.

| Keys | What | When |
|---|---|---|
| `DATABASE_URL` | The PostgreSQL connection | Always |
| `ENCRYPTION_KEY` | Encrypts every stored credential. **Keep a copy outside the server**: without it no credential opens, not even from a backup | Always |
| `APP_ADMIN_PASSWORD_HASH`, `APP_TOTP_SECRET` | The login, from `auth-setup` (until they're set, nobody can sign in) | Always |
| `ANTHROPIC_API_KEY` | The Claude API | Always, in practice |
| `APP_ORIGIN` | Exactly the address you open in the browser, without a trailing `/`. Live updates accept only this origin | Always, except in development |
| `TZ` | Your time zone, for schedules, the morning brief and the weekly review. Empty: UTC in the containers | Recommended |
| `LLM_MONTHLY_BUDGET_USD` | Pauses non-essential pipelines when the month's LLM cost reaches it (also in Settings) | Recommended |
| `VNC_PASSWORD`, `VNC_VIEW_PASSWORD` | Watching and taking over browser runs live. Empty: browser runs still work, unwatched | Browser steps |
| `IMAP_HOST`, `SMTP_HOST` and ports | Your mail servers; Gmail's are the default. The address and password go on the **Credentials** page, not here | Email steps |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `HOOKS_PUBLIC_URL` | The bot, your Telegram user id, and the webhook address ([docs/telegram.md](docs/telegram.md)) | Telegram, webhooks |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | [docs/google-calendar-setup.md](docs/google-calendar-setup.md) | Calendar steps |
| `OPENAI_API_KEY` | Embeddings for examples in drafts | Optional |
| `HEALTH_REPORT_TOKEN` | Lets the server's own jobs (backups, disk checks) report to the Health page | Optional |

The rest can stay as it is: the models have defaults (changeable per step type in Settings), and the containers set
the ports and folders themselves.

## Documentation

| | |
|---|---|
| [docs/capabilities.md](docs/capabilities.md) | Apps, every step type, trigger and event, with examples |
| [docs/design.md](docs/design.md) | How it works: principles, pipelines, gates, architecture, security, data model |
| [docs/self-hosting.md](docs/self-hosting.md) | Install, HTTPS, webhooks and Telegram, updates, backups |
| [docs/telegram.md](docs/telegram.md) | What the bot does |
| [docs/google-calendar-setup.md](docs/google-calendar-setup.md) | Connecting Google Calendar |
| [pipelines/](pipelines) | Example pipelines and Apps |

Comments and commits cite milestone ids such as `M12-T5`: they come from the project's development plan and mark
when and why something was added.

## How this was built

Storm was designed and directed by [Trayan Manolov](https://github.com/trayanm) and written with
[Claude Code](https://claude.com/claude-code), Anthropic's coding agent: plans, code, tests and documents came out of
that collaboration, with every change reviewed, tested and run on a real deployment before it was kept. The commits
don't carry per-commit AI attribution; this section is the disclosure for all of them.

## Security

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). If you run a modified Storm as a service for others, you must offer them its source.
