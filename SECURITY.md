# Security policy

Storm holds credentials, reads mail and drives a browser, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/realentity/realentity-storm/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer within a
week. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

Only the latest `main` is supported. Storm is self-hosted: update with `git pull` and `./docker/storm up`
([docs/self-hosting.md](docs/self-hosting.md)).

## Scope

In scope, for example:

- Anything that lets content from outside (an email, a web page, a webhook, a download) trigger an action without the
  user's **Act**, or change what an approved action sends.
- Reading stored credentials, or getting them into an LLM prompt, a log or a page.
- Getting past the login, the session checks, or the hooks-only site's checks (Telegram secret, webhook token or
  signature).
- Making the worker reach private or local addresses through `http.fetch` or the browser steps.

Out of scope: problems that need an already compromised host or `.env`, and attacks on a deployment that publishes
the app itself (not only the hooks-only site) to the Internet against [docs/self-hosting.md](docs/self-hosting.md).

The design behind these boundaries: [docs/design.md](docs/design.md) §1, §7 and §16.
