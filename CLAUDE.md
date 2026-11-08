# Working on Storm

This repository is public. Everything committed here, in every commit, is visible to everyone.

## Commits and pull requests

- No AI attribution: no co-author trailer naming an AI and no "generated with" line, in commit messages or pull
  request descriptions. The README's "How this was built" discloses it once. `.claude/settings.json` turns the trailers off
  and `.githooks/commit-msg` refuses them.
- One small branch per change, from an up-to-date `main`, named by kind: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- The branch goes to GitHub with a pull request to `main`; CI runs on it (the browser tests only run on pull
  requests). It is squash-merged: one commit on `main` per change, the pull request's title as its message, so the
  title says what changed. `main` stays linear.
- After the merge the branch is deleted, on GitHub and locally (`git branch -D`, since a squashed branch doesn't look
  merged; `git fetch --prune`).
- Before committing: `pnpm lint`, `pnpm typecheck`, `pnpm test`; for changes to the api or worker also
  `pnpm test:e2e` (Docker); for the web app `pnpm test:web`.

## Secrets and private data

- Never commit `.env`, `.infisical.yaml`, keys, tokens, passwords, database dumps, screenshots or run files, and never
  paste a real value from `.env` into code, tests, docs or a commit message. Examples and tests use made-up values.
- Keep the maintainer's own setup out of the repository: no host names, private domains, IP addresses, file paths
  of a particular machine, email addresses or other personal data. Use `example.com`, `*.example`, `*.test` and
  neutral names instead. `.githooks/pre-commit` (gitleaks) and `.githooks/pre-push` (a private list of forbidden
  patterns) check this, and CI runs gitleaks over the whole history.
- Credentials live encrypted in the database (docs/design.md §7); the LLM only ever sees references like
  `{{cred:mail}}`. Keep it that way.

## Documentation

- A new or changed step type, trigger or event goes into `docs/capabilities.md` in the same change.
- How it works: `docs/design.md` (its `§` numbers are cited from the code). Running it: `docs/self-hosting.md`.
- Milestone ids in comments (`M12-T5`) come from the development plan; keep them as they are.
