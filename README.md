# RealEntity Storm

<img src="apps/web/public/logo.svg" alt="" width="64" height="64">

**Storm** for short; part of [RealEntity](https://github.com/realentity).

A self-hosted agent that reads email, watches sites, finds jobs, prepares replies, fills forms and uploads files on
your behalf. **You describe what you want in a chat, Storm compiles it into a structured pipeline, and nothing leaves
the system without your explicit "Act".** It learns from how you edit its proposals.

Single user, on your own machine, off the Internet.

## What it does

- **Pipelines from a description.** A builder turns plain language into a pipeline built only from a fixed catalog of
  step types (mail, browser, HTTP, LLM, data, calendar, Telegram, gates). Runs execute that definition, not prose.
  You can also write the YAML yourself, or use the visual editors.
- **Propose, then act.** Every step with a side effect is preceded by a gate that shows the exact payload: the email
  body, every form field, every file, the target address. You edit it if needed and press **Act**.
- **A browser you can watch and take over.** Browser steps run in a real Chromium, visible live in the app. CAPTCHAs,
  2FA and odd dialogs are handed to you; you click and type on the site, then continue.
- **Untrusted input is data.** Emails, pages and downloads never trigger actions. A policy layer (allowed domains,
  limits, a kill switch) decides what a step may do; the LLM only proposes.
- **Secrets never reach the LLM.** Credentials are encrypted in PostgreSQL (envelope encryption, key in `.env`); the
  LLM sees only references like `{{cred:mail}}`.
- **Apps.** Group types, pages, stages and pipelines into small apps (job search, bills, prices, releases), with
  ready-made examples to install.
- **Telegram.** Approve proposals, answer questions, run pipelines and use the kill switch from your phone.
- **Everything recorded.** Each run keeps its pipeline version, steps, inputs, outputs, screenshots and traces.

## Get started

- **Run it on a server:** [docs/self-hosting.md](docs/self-hosting.md) (Docker, PostgreSQL 17 with pgvector, HTTPS
  of your choice).
- **Develop:**

```bash
# Node 22.12+ or 24, pnpm 10, Docker
pnpm install
cp .env.example .env                                   # then set ENCRYPTION_KEY (openssl rand -hex 32), ANTHROPIC_API_KEY
docker compose -f docker/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm auth:setup                                        # the login: password + authenticator code, into .env
pnpm --filter @realentity/storm-worker exec playwright install chromium
pnpm dev                                               # api, worker and web
```

Tests: `pnpm test` (unit), `pnpm test:e2e` (integration, PostgreSQL in Testcontainers), `pnpm test:web` (browser
tests with Playwright).

## Documentation

| | |
|---|---|
| [docs/design.md](docs/design.md) | How it works: principles, pipelines, gates, architecture, security, data model |
| [docs/capabilities.md](docs/capabilities.md) | Every step type, trigger and event, with examples |
| [docs/self-hosting.md](docs/self-hosting.md) | Install, HTTPS, webhooks and Telegram, updates, backups |
| [docs/telegram.md](docs/telegram.md) | What the bot does |
| [docs/google-calendar-setup.md](docs/google-calendar-setup.md) | Connecting Google Calendar |
| [pipelines/](pipelines) | Example pipelines and apps |

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
