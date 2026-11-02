# AI ME

A personal, self-hosted agent that reads email, finds jobs, prepares replies, fills forms and uploads files on my behalf. **I describe what I want in a chat, the app compiles it into a structured pipeline, and nothing leaves the system without my explicit "Act".** The agent learns from how I edit its proposals.

Runs on my own server (Ubuntu + Docker), inside my private network.

---

## 1. Core principles

1. **Describe in chat, run as structure.** Pipelines are authored in natural language and compiled into a validated definition built only from a fixed catalog of step types. Runs execute that definition, not prose.
2. **Propose, never act blindly.** Every side-effect step is preceded by a gate that shows the exact content to be sent or submitted: email body, every form field value, every file to upload, the target URL. I review it, edit it if needed, and press **Act**.
3. **Watchable execution.** Browser runs are visible live inside the React app. I can take over at any moment (CAPTCHAs, 2FA, unexpected dialogs) by clicking and typing directly on the site.
4. **Untrusted input is data, not instructions.** Emails, web pages and downloaded files can never trigger actions by themselves. The LLM only proposes. A policy layer decides what a step is *allowed* to do.
5. **Secrets never reach the LLM.** Credentials are stored encrypted in PostgreSQL (envelope encryption, root key in `.env`). The LLM only sees references like `{{cred:linkedin}}`, and the worker decrypts them at the moment of use.
6. **Everything is recorded and versioned.** Every run keeps the pipeline version it ran, its steps, inputs, outputs, screenshots and Playwright traces.
7. **Learn from my decisions.** Each approve, edit or reject is stored and feeds future drafts (few-shot retrieval + approved rules).
8. **Private network only.** Not exposed to the internet. Access goes through Tailscale.

---

## 2. Pipelines

### 2.1 Authoring a pipeline in chat

The chat is how a pipeline is **authored**, not how it **runs**. A builder LLM turns my description into a pipeline definition, using the step catalog (§2.3) as its only building blocks.

```text
Me (chat): "Every weekday at 8, check jobs.bg and dev.bg for senior .NET
            roles in Sofia or remote, skip agencies, score them against my
            profile and send me the top 10. For the ones I approve, prepare
            a tailored CV and cover letter and fill the application."
     │
     ▼
Pipeline builder (LLM, step catalog as tools)
 ├─ asks clarifying questions ("Minimum score? Which CV is the base?")
 ├─ flags missing pieces ("No recipe for dev.bg yet; we'll create one together")
 └─ produces a pipeline definition (JSON, validated with zod)
     │
     ▼
Review screen: readable plan + step graph + diff vs previous version
     │
     ▼
Dry run (no side effects, shows what *would* be proposed) → Save as v1 → Enable / schedule
```

**Why compile instead of interpreting prose on every run:**

- **Safety:** the policy layer knows up front what a pipeline can do ("sends email to recruiters, never uploads files"). Gates are inserted automatically.
- **Repeatability:** the same steps run every time, and only the content changes.
- **Learning per step:** edits on a "draft reply" step feed that step's examples and rules.
- **Diffs:** every change is a visible version (v3 → v4), and runs reference the exact version they used.

### 2.2 Pipeline definition

Stored as JSON, shown in the UI as a readable plan. Example (YAML for readability):

```yaml
name: Daily .NET job search
trigger: { schedule: "0 8 * * 1-5", tz: Europe/Sofia }
steps:
  - id: search
    type: browser.extract          # headless
    with:
      recipes: [dev.bg/search]
      params: { category: net }   # a list runs one search per value
  - id: dedupe
    type: data.dedupe
    with: { from: "{{search.items}}", key: url, against: JobPosting }
  - id: filter
    type: llm.classify
    with:
      items: "{{dedupe.items}}"
      instruction: "Exclude recruitment agencies."
  - id: score
    type: llm.score
    with: { items: "{{filter.kept}}", against: profile, top: 10 }
  - id: shortlist
    type: gate.review               # I pick which jobs proceed
    with: { items: "{{score.top}}", mode: select }
  - id: map
    type: browser.mapForm           # read-only: reads the form, types nothing, attaches nothing
    forEach: "{{shortlist.selected}}"
    with:
      url: "{{item.url}}"           # the posting: its form, or the one behind its Apply button
      cv: cv-main                   # my stored CV (Profile page), for the CV field
      job: "{{item}}"
      message: "Why this role fits me, from my profile only, 2-3 sentences."
  - id: approve
    type: gate.act                  # every field value, every file, target URL; I press Act
    forEach: "{{shortlist.selected}}"
    with: { for: apply }
  - id: apply
    type: browser.fillAndSubmit     # headed, watchable; executes exactly the approved payload
    forEach: "{{shortlist.selected}}"
    with:
      url: "{{map.formUrl}}"
      fields: "{{map.fields}}"
      files: "{{map.files}}"
      stopBeforeSubmit: false
limits:
  browser.fillAndSubmit: 10/day
```

**Definition rules:**

- `{{stepId.field}}` references outputs of earlier steps. The compiler validates references and types against each step's zod output schema.
- `forEach` fans a step out over a list. Each item gets its own proposal and approval. Steps that iterate over the same list are aligned per item: inside them, `{{prepare.cv}}` is the current item's value (elsewhere it is the list of all items' values), and an item rejected at a gate skips the following steps for that item.
- **Gates:** a `gate.act` names the side-effect step it approves (`with: { for: apply }`), comes before it and iterates over the same items. Its proposal is that step's exact resolved input. Authors may place gates explicitly; the compiler **inserts** one (`<step>Gate`) before any side-effect step without one. In v1 gates can't be removed, only added.
- **Map → gate → act:** steps that interact with external forms are split into a read-only mapping step that produces the payload, a gate, and a single side-effect step that executes it. No browser is held open while a proposal waits for me.
- **Attaching a file counts as an upload.** Any step that selects files on an external site is a side-effect step, since many ATSs upload on file selection.
- **Limits:** a pipeline may declare rate limits for its side-effect step types (`limits: { browser.fillAndSubmit: 10/day }`, `N/day` or `N/hour`, a rolling window), counted over its own runs. Settings hold global caps per step type, counted over every pipeline. When a limit is reached, the run waits (`Run.resumeAt`) and continues once the window allows.
- **Page (`view`, M27):** a pipeline that keeps a collection (`data.save` with `collection`) may declare its page: a menu entry, columns (a field by dotted path, in a fixed format: text, number, money, date, link, …), sort, my marks (`done`, kept apart from what the pipeline saves) and buttons that start pipelines (the page's as a manual run, a row's with the row as `{{trigger.item}}`). The compiler checks the collection is this pipeline's; a row's values are always shown as text and links are http(s) only.
- **Policy:** each pipeline version declares what its side-effect steps may target, shown on the review screen and enforced by the policy layer at run time:

  | Kind | Example | Enforced how |
  |---|---|---|
  | Static | `allowedDomains: [jobs.bg, dev.bg]` | Fixed list in the definition |
  | Provenance | `recipient: sender(of: fetch.thread)`, `domain: hostOf(item.applyUrl)` | The value must come from that source step's actual output; the LLM can't invent it |
  | Run-time new | A job on an ATS never seen before | The gate highlights **"New domain: X"**; approving can optionally add X to the static list |

### 2.3 Step catalog

The builder can only use these. Each step type is a TypeScript class in the worker with zod schemas for inputs and outputs, and these schemas are what the builder is given (rendered into its system prompt) and what its proposals are compiled against, so a step or parameter it invents never becomes a pipeline.

| Group | Steps | Side effect? |
| --- | --- | --- |
| Email | `email.fetch`, `email.classify`, `email.draftReply`, `email.awaiting`, `email.draftFollowUp`, `email.send` | `send` |
| Bills | `bill.read`, `bill.save` | none |
| Browser | `browser.open`, `browser.extract`, `browser.download`, `browser.mapForm`, `browser.fillAndSubmit`, `browser.upload`, `browser.agent`, `browser.submit` | `fillAndSubmit`, `upload`, `submit`* |
| LLM | `llm.classify`, `llm.score`, `llm.generate`, `llm.summarize`, `llm.extract` (named fields out of an email or page: times as ISO 8601 with their offset); `llm.score` with `outcomes: true` calibrates on my applications' outcomes (interviews, rejections, no answer in 3 weeks) | no |
| Applications | `application.outcome`: what an email says about one of my submitted applications (replied, interview, rejected), matched by the company first; the application moves forward only, the date of each outcome kept, and `application.status` emitted | no (internal DB) |
| Data | `data.dedupe`, `data.filter`, `data.save` (job postings, or a collection of mine with `added` / `changed` / `removed`), `data.history` (a number per key over time: previous, change, min, max, lowest), `data.lookup` | no (internal DB only) |
| HTTP | `http.fetch`: GET without a browser; RSS/Atom feeds become items, JSON stays data, pages become text; only hosts on `policy.allowedDomains`, never private or tailnet addresses (also after DNS and redirects); an unchanged address (ETag / Last-Modified, 304) reuses what was read | no |
| Shop | `shop.product`: the price of a product, or of one variant (`select: { size: M, color: Black }`), from its page: the page's schema.org data (Product, ProductGroup and its variants) or price meta tags, without a browser; a page without them, or one that refuses plain requests, in the headless browser; with no data there either, the cheap model reads the price from the text. `id` (product + variant) is the key for `data.history`. Same host and address rules as `http.fetch`; in the browser, every page and redirect is checked before it is followed | no |
| Files | `file.read` (a document's or a download's text: text files, PDFs, parsed in a child process); my documents (CV, cover letters) are uploaded on the Profile page, not generated or stored by a step | no |
| Calendar | `calendar.find` (my Google Calendar's events in a window), `calendar.create` (an event; with `attendees`, Google emails them an invitation from my account; guests are recipients, like `email.send`'s `to`; the same title at the same start isn't created twice) | `create` |
| Flow | `flow.later` (start another pipeline later with data, once, unless `flow.cancel` with its key or an event matching `cancelOn` cancels it first), `flow.cancel` | no |
| Gates | `gate.review`, `gate.act`, `gate.takeover` | — |
| Notify | `notify.digest`, `notify.telegram` | to me only |

\* `browser.agent` sends nothing itself: what it would submit is the payload of `browser.submit`, behind a gate.

New capabilities are added by writing a new step class, never by the LLM.

**Follow-ups (M22):** `email.awaiting` reads the Sent folder (the one the server marks `\Sent`, else one named like it) and the inbox, read-only, and lists my emails whose thread got nothing back for `afterDays`, matched by Message-ID, In-Reply-To and References, never by subject; automatic addresses (no-reply and the like) are left out, and so is a thread with `maxFollowUps` follow-ups in a row already. Each of my emails is listed once ever, so rejecting the follow-up at the gate leaves the thread alone, and writing in it again makes it count again. `email.draftFollowUp` writes the nudge in the email's language and learns from my edits like `email.draftReply`; `email.send` sends it in the thread. See `pipelines/email-follow-ups.yaml`.

**Prices (M24):** the **Prices** page keeps the products I watch: a name, a target price and its currency, and one or more shop pages (with the variant in the page's own words, `size=M, color=Black`). `price.watch` reads each page the way `shop.product` does, keeps each shop's price (a year of them), and says only what's new: a shop at or under the target (once, when it crosses), the lowest in 90 days, back in stock, naming a cheaper shop when there is one; nothing when nothing changed. The page shows each product's cheapest shop now and its price per shop over 90 days. The addresses are mine, entered on the page, so `pipelines/prices.yaml` needs no allowedDomains; each read may still go to its own shop only.

**Bills (M23):** `bill.read` gives each email's text and the text of its PDF attachments (up to two, read in a child process like `file.read`) to the LLM, which says whether it is a bill (an amount to pay, not a receipt or an offer) and reads the issuer, amount, currency, due date, period and reference; it never guesses a field the text doesn't give. `bill.save` keeps them on the **Bills** page, one row per bill (the sender's domain with the reference, else the period, else the due date), so a reminder email or a retried run updates the row; it lists the new ones with a due date for `calendar.create` (a reminder 3 days before, behind its gate) and tells when a bill is more than 30% above the issuer's usual (the median of its last six). Nothing is paid: the page marks bills paid by hand. See `pipelines/bills.yaml`.

**Conditions (`when`):** any step can carry `when: "{{step.field}}"`: it runs only when that value isn't empty (a non-empty list or text, true, a number other than 0); otherwise it is skipped, and so is every later step that uses its output. A watch tells me only about changes this way: `http.fetch` → `data.save` into a collection → `llm.summarize` with `when: "{{save.added}}"` → `notify.telegram` (see `pipelines/release-watch.yaml`, `pipelines/price-watch.yaml`, `pipelines/product-watch.yaml`). A run that skipped steps this way says so at the top of its page ("Done, nothing to tell: cheaper.items was empty, so tell was skipped"), with what it read where a step reports it (`shop.product`: each product's price and stock).

### 2.4 Browser steps: recipes vs agent

1. **Recipe steps** (`browser.extract`, `browser.mapForm`, `browser.fillAndSubmit` on a known site) follow saved selectors and flows (`SiteRecipe`). They're fast, cheap and predictable.
2. **`browser.agent`** is a bounded LLM browser agent for sites without a recipe ("find the apply button and fill the form"). It's limited to its start address's site and the pipeline's allowed domains, an action budget (`maxActions`), and a fixed action set (navigate, click, type, select, tick, attach one of the step's `documents`, read, screenshot, finish). It works from the page's outline (one line per element with a ref, its role, name and state, and the text around them), with screenshots only when it asks.

**Agent: map → gate → act, again.** `browser.agent` is read-only, like `browser.mapForm`: it fills the form in its own page and sends nothing. A button that submits a form is refused; every request carrying a value it typed (in the address or the body, plain or encoded) is blocked, so a draft that saves itself as it types stays unsaved; WebSockets are closed; attaching only records which approved document goes to which file field (picking a file is an upload on many sites). It ends with `finish`: **ready** (a form filled, and its final button), **done** (nothing to send: an answer) or **failed**. Its recorded actions, files and final button are the payload of **`browser.submit`**, which I see at the gate (every typed value editable) and which then repeats them exactly in the live browser, without an LLM: each element must still be there with the same role and name, else the run pauses with nothing sent; files are the approved documents, checked by content; a person check is mine; `stopBeforeSubmit` leaves the final button to me. After three failed actions in a row (or when it gives up), Sonnet hands the page as it is to Opus (task `browser.agent.escalation`) in a new conversation with what was done so far; failing again, or reaching the budget (after one last turn to finish), fails the step with what happened.

A list recipe ([packages/steps/src/recipe.ts](packages/steps/src/recipe.ts)) is data, not code: the list's address with `{param}` placeholders, a selector per item, a selector (and attribute) per field, the field that identifies an item, an optional "no results" selector, and paging by next link or by page number. It never opens a page off its own site (the host in its name, `dev.bg/search`), reads at most 20 pages, and waits at least half a second between them (1.5 s by default). Example: [recipes/dev.bg-search.yaml](recipes/dev.bg-search.yaml). `browser.extract` uses the latest version; when the page stops matching (nothing matches the item selector, or no item has the required fields), the step fails saying what didn't match, the recipe is marked broken on the Recipes page and in the digest, and I get one Telegram message. A recipe that keeps reading only its "no results" page for 7 days (the site may have changed so that the list looks empty) is told once too, and the Recipes page shows it as quiet, with when it last found something, until it finds items again.

**Teach mode** (Recipes page → **Teach**): a run of a "Teach <recipe>" pipeline whose `browser.teach` step opens the site in the live browser. I bring it to the list (search, filters, cookie banner) and press Continue. The LLM (the writing model, Sonnet, by default; Settings can choose another) gets the page's outline (tags, classes, links, short texts; long runs of similar elements shortened, no scripts) and proposes a recipe; it is checked on the page: the address rebuilt from the params must be the page's, the items must have the fields, the next page (opened in another tab) must show other items. A list of one item counts (I check what is outlined). What fails goes back to the LLM, up to three times, and the page's outline is the cached start of each ask, so a retry costs a fraction of the first; a fix that fails the same way ends it. The form asks what the list holds (job ads, products, or my own fields) and explains each step. The items it reads are outlined on the page; Continue saves the recipe as the next version, Abort discards it. Recipes can also be imported as YAML.

**Recipe fallback** (`browser.extract` with `fallback: true`): when a recipe no longer matches its page, the fix already waiting for me is tried first, without an LLM. Otherwise `browser.agent` (read-only, on the recipe's site only, at most 10 actions) brings the page back to the list, and teach mode's recipe writer proposes a recipe from that page, checked on it the same way. The fix is kept on the broken version as a proposal, not as a version: the run reads with it, the Telegram message and the digest say a fix waits, and on the recipe's page I save it as the next version or discard it.

**Application forms** (M10, map → gate → act): `browser.mapForm` opens the posting (following its Apply button when the form isn't on the page) and reads every field, wizard steps included, typing and attaching nothing. Each value comes from my profile (Profile page: plain text, my facts) or, for a free-text question, is written for this job from my profile and the posting only; a question my profile doesn't answer stays empty. My CV (a stored document, `cv: cv-main`) goes to the CV field, bound by id and SHA-256. A question that checks I'm a person ("104-43=") is never sent to the LLM or answered by the step, and a honeypot ("leave this field empty") is never shown or filled. At the gate the form shows field by field: I edit values and attach other documents (a cover letter, say; AI ME only attaches them). `browser.fillAndSubmit` then opens the form in the live browser and reads it again: a field gone, a new required field, a choice no longer offered or another site pauses the run with nothing sent. It fills exactly what I approved, step by step through a wizard, waits for me to answer a person check, and sends; with `stopBeforeSubmit` I press the final button myself. A send counts when the form is gone, or (forms sent without leaving the page) a thank-you appears or the form is cleared. The posting's `Application` goes from prepared to submitted, and the posting to applied.

**Insight** (M16): the Insight page counts the postings found in a period (30 to 365 days) and what came of them: shortlisted, applied, replied, interviews, rejections, still waiting, the median days to a first answer; by source, and by score band (the calibration view: do better scores get more replies and interviews?). An application's outcome is set by an email (`application.outcome`, see `pipelines/application-replies.yaml`) or by hand on the Jobs page; each outcome's date stays when the status moves on, so an interview that ended in a rejection still counts as an interview, and either way `application.status` is emitted (it cancels a pending follow-up).

**Facts about me** (M15): what forms ask that only I can say (a salary expectation, a start date, relocation) and my answers, on the Profile page. A fact comes only from me: a form answer I filled in or changed at the gate (short fields, not free text, files or checkboxes), my answer to a question a run asked, or one I write on the Profile page; a page's text or the LLM alone never writes or changes one. `browser.mapForm` and `browser.agent` get my facts with my profile and use one when a field asks the same thing, even worded differently, word for word (the gate shows "from my facts", and which one); a fact the LLM names must be one of mine with my answer, or the field stays empty. A required field neither answers is asked: on Telegram (a reply to the message is the answer) and on the run page; the run waits (up to TAKEOVER_TIMEOUT_MINUTES, then the field stays empty for the gate), and the answer becomes a fact, so the next form doesn't ask again. `browser.agent` asks the same way (M18), with an `ask` tool: at most 3 questions a run, never one about a password, a code, a login or a card (those are mine, in the live view), and it types my answer with source `asked`; the recipe fallback's agent, which only reads, can't ask.

### 2.5 Editing via chat

Each pipeline page has a chat panel bound to that pipeline:

- "Also include Plovdiv" changes the parameters of the `search` step. It's shown as a diff, and saved as a new version after I confirm.
- "Why did it skip the Acme job?" makes the builder read that run's step outputs and answer from them.
- Suggestions from the reflection job ("you rejected 8 of 10 agency jobs that passed the filter; tighten it") appear in the same chat as a proposed diff.

**How the builder works** ([apps/api/src/builder](apps/api/src/builder)): Claude Opus with the step catalog in its cached system prompt (every step's parameters, bounds, defaults and flags, rendered from the zod schemas) and three tools:

| Tool | What it does |
| --- | --- |
| `propose_pipeline` | The whole definition, compiled at once by the same compiler as hand-written YAML. Compile errors go back to the builder to fix; what compiles (gates inserted, policy derived) is shown as a proposal with its plan, step graph and diff against the current version. |
| `list_runs`, `read_run` | The pipeline's runs: each step's status, input and output, long texts shortened and marked as data. |

Nothing the builder does is saved or run: a proposal becomes the next version (or v1 of a new pipeline) only when I press **Save**, a **Dry run** stores it as the draft first, and **Open in the editor** hands it to the YAML editor. It asks back when something essential is open, and says plainly when the catalog has no step for a request (a website before M8) instead of imitating it. A new pipeline is described on the **Describe a pipeline** page. Each chat keeps its conversation exactly as the API saw it (thinking blocks included, append-only) and stops at `BUILDER_CHAT_MAX_TOKENS`. Run data and emails could try to steer the builder; that can only produce a proposal, which I review as a diff, and gates are still inserted by the compiler.

### 2.6 Execution

The worker interprets a `PipelineVersion` step by step:

- Each step is persisted as a `Step` with resolved inputs, outputs, status and screenshots.
- Gates pause the run (`WAITING_FOR_USER`) and create a `Proposal`. The run resumes when I decide.
- Runs are resumable: after a restart, the worker continues from the last completed step.
- Retries are per step and configurable. Side-effect steps are never retried automatically.
- **Kill switch:** one button in the UI (`PUT /api/kill-switch`) pauses all pipelines (schedules fire but start nothing), stops queued and waiting runs and expires their open proposals, so no queued side effect can execute. Runs already in progress stop at their next step boundary. Releasing it doesn't restart stopped runs.
- **Budget:** when this month's LLM cost (`Step.llmUsage`) reaches the budget (Settings, else `LLM_MONTHLY_BUDGET_USD`), runs of non-essential pipelines stop before their next step that calls the LLM (the catalog marks them: the `llm.*` and email steps, `shop.product`, `application.outcome`, `browser.mapForm`, `browser.agent`, `browser.teach`), and `browser.extract` fails instead of trying its fallback. Pipelines marked essential keep running. The AI ME bot says so at 80% of the budget and when it is reached, once a month each. Settings shows this month against the budget and the last 30 days' cost by step type and model.
- **Queue:** pg-boss in PostgreSQL. `runs` advances runs in parallel; `runs-headed` is a singleton queue, so one headed run at a time across all workers; `pipeline-trigger` fires cron schedules in the pipeline's time zone (keyed by pipeline); the worker reconciles schedules with the enabled pipelines at startup and whenever the api asks. A decision queues its run again. The runner claims a run before advancing it, so a duplicate or retried job is harmless.

### 2.7 Triggers, webhooks and the AI ME bot

Besides `manual` and `{ schedule, tz }`, a pipeline can start on what happens (M12):

| Trigger | Starts when | `{{trigger.*}}` |
| --- | --- | --- |
| `{ on: run.finished, pipeline: Jobs, status: [DONE] }` | a run of that pipeline (by name) finishes; `status` defaults to `[DONE]`, `FAILED` allowed | `runId`, `pipeline`, `status`, `summary`, `outputs` (each step's output by id) |
| `{ on: application.status, status: [INTERVIEW] }` | an application is prepared, submitted, … (any status when left out) | `applicationId`, `status`, `job` (title, company, location, url) |
| `{ on: recipe.broken, site: dev.bg }` | a recipe stops matching its page (once per breakage) | `site`, `recipe`, `version`, `reason`, `fixProposed` |
| `{ on: email.classified, label: [recruiter] }` | an `email.classify` step gives an email one of these labels (one run per email) | `label`, `reason`, `message` (the email) |
| `{ on: view.action, collection: releases }` | I press a row's button on a pipeline's page (M27), started by the api, not an event | `collection`, `key`, `item` (the row), `action` |
| `{ webhook: hmac-sha256 }` or `{ webhook: token }` | a call to the pipeline's webhook address | `body` (JSON, or the text), `event` (`X-GitHub-Event`), `receivedAt` |

- **Only enabled pipelines** start on a trigger, never with the kill switch on, never on their own event, and a chain of triggered runs stops at depth 3. Dry runs trigger nothing.
- `{{trigger.*}}` is type-checked by the compiler against the event, and available only in a pipeline with that trigger. As a side effect's **target**, only an email's own addresses (`trigger.message.*`) or a posting's URL (`trigger.job.url`) may be used: a webhook body is written by whoever calls it, and a finished run's outputs may be LLM text.
- **Webhooks:** the pipeline page creates the address (`https://hooks.example.com/aime/<id>`, 32 random bytes) and a secret, shown once and rotatable. `hmac-sha256` checks a GitHub-style `X-Hub-Signature-256` over the body as sent; `token` an `Authorization: Bearer` header. The api checks the address, the size (64 KB) and a token (against its SHA-256) and queues the call; the **worker** checks a signature, since only the worker decrypts (§7). The body is data, like an email's text.

**The AI ME bot** (its own Telegram bot, not n8n's):

- **Tells me** what a run waits for: each new proposal with **Approve / Reject / Open** (one message for a gate with more than 5), "needs you" with **Open the live view**, a broken recipe with **Open the recipe**. When I decide anywhere, the message says so and loses its buttons.
- **Approve on Telegram** only when the message holds the whole payload, nothing new is targeted, the proposal is still waiting and its payload hash is the one the button carries; anything else opens AI ME. **Settings → Approve on Telegram** turns the buttons off.
- **Commands:** `/run <pipeline>` (by name or the start of it), `/status`, `/inbox`, `/pause` and `/resume` (the kill switch), `/help`. Only from my private chat (`TELEGRAM_CHAT_ID` is my user id); commands older than 5 minutes are dropped.
- **The builder (M21):** any other message goes to the pipeline builder, and its answer comes back with the proposal (what it does, when, its steps, the warnings) and Save, Dry run and Open in AI ME. The chat goes on while I'm on it (two hours); `/new` starts over, `/edit <pipeline>` talks about one pipeline. A saved pipeline is off until I press Turn on. The answer comes in the background ("typing…" meanwhile), since a turn can take longer than Telegram waits.

**How it reaches AI ME,** which stays off the Internet: Telegram and webhook callers → Cloudflare (`hooks.example.com`) → the VPS's Traefik → **hooks-gateway** (checks the bot's secret path and header and my user id, or the webhook path's shape and size) → Tailscale → server `:8101`, a second Caddy site that serves only `POST /hooks/*` → the api's `/api/hooks/*`. The api checks Telegram's secret header and my user id again. The VPS can reach nothing else of AI ME.

---

## 3. Proposal lifecycle (gates)

```text
                 step output reaches a gate
                          │
                          ▼
                Proposal (exact payload)
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
    Reject             Edit → save         Approve
  (+ reason)           diff, then            │
                       Approve               ▼
                                     Press "Act"
                                          │
                                          ▼
                 Execute next step (worker, Playwright / API)
                 ├─ live view in the React app
                 ├─ pause on CAPTCHA / unknown state → I take over
                 └─ every step logged + screenshot
                                          │
                                          ▼
                 Result + report  ──►  Reflection (suggested rules / pipeline diffs)
```

**Proposal states:**

```text
PENDING_REVIEW ──► APPROVED ──► EXECUTING ──► DONE | FAILED
      │                            ▲  │
      │                            │  ▼
      │                      WAITING_FOR_USER
      └──► REJECTED | EXPIRED (kill switch)

PREVIEW: a dry run's proposal; never approved, never executed
```

Decisions go through `POST /api/proposals/:id/approve` (optionally with an edited payload, still validated against the step's input schema, and any new targets it introduces) and `POST /api/proposals/:id/reject` (optional reason). Each records a `Decision` (approved, edited with the changed fields, or rejected) and queues the run.

**Payload integrity:** the payload I approve is hashed. The worker executes only that exact payload. If a page requires anything not in it (an extra field, a different URL), the worker **pauses** and asks. It never improvises.

---

## 4. Architecture

```text
                 Tailscale
                     │
            ┌────────▼────────┐
            │  web (React)    │  builder chat, pipelines, approval inbox, live view (noVNC),
            └────────┬────────┘  history, rules, credentials
                     │ REST + WebSocket
            ┌────────▼────────┐        ┌──────────────────────────────┐
            │  api (NestJS)   │◄──────►│  PostgreSQL                  │
            │  builder (LLM)  │        │  + pgvector                  │
            │  encrypts only  │        │  + pg-boss queue             │
            └────────┬────────┘        │  + encrypted credentials     │
                     │ jobs            └──────────────────────────────┘
            ┌────────▼───────────────┐
            │  worker (NestJS)       │
            │  ├─ pipeline runner    │
            │  ├─ step catalog       │
            │  ├─ IMAP/SMTP (Gmail)  │
            │  ├─ Playwright         │──► Chromium (headed) on Xvfb :99
            │  ├─ LLM (Claude API)   │                │
            │  └─ crypto (decrypts)  │      x11vnc + noVNC (:6080) ──► live view in web
            └────────────────────────┘
            (optional) py-worker: local embeddings / models, document parsing
```

### Components

| Component | Tech | Responsibility |
| --- | --- | --- |
| `apps/api` | NestJS, Prisma | Pipeline builder chat, pipelines & versions, proposals, decisions, runs, rules, recipes, credentials (encrypt only), auth, WebSocket events |
| `apps/worker` | NestJS standalone app, Playwright | Pipeline runner + step implementations. Only place where credentials are decrypted |
| `apps/web` | React + TypeScript + Vite | Builder chat, pipeline review/diff, approval inbox, payload editor, live view, history, rules, credentials (write-only) |
| `packages/shared` | TypeScript | DTOs, enums, zod schemas: pipeline definition, step inputs/outputs, proposal payloads |
| `packages/steps` | TypeScript | Step catalog metadata (names, schemas, side-effect flags), shared by builder (api) and runner (worker) |
| `packages/crypto` | TypeScript, `node:crypto` | Envelope encryption (AES-256-GCM) |
| `packages/llm` | TypeScript, `@anthropic-ai/sdk` | Claude client, model routing per task, prompt caching, structured output via tool use |
| `py-worker` (optional) | Python, FastAPI | Local embeddings / models, OCR/document parsing, only if needed |
| PostgreSQL | + `pgvector` | Data, embeddings, queue (`pg-boss`, so no Redis), encrypted secrets |
| Browser stack | Chromium + Xvfb + fluxbox + x11vnc + noVNC | Watchable, controllable browser for Playwright |

### Why these choices

- **Email via IMAP/SMTP, not Playwright.** It's reliable, fast and doesn't trip bot detection. Playwright is only for sites without APIs. v1 uses a Google **app password** (stored as an encrypted credential) behind a `MailConnector` interface. The Gmail API (OAuth) can replace it later if labels, threading or push are needed. Check Google's current rules for unverified apps first: refresh tokens of OAuth apps in "Testing" status have expired after ~7 days.
- **Playwright in Node.** It's first-class, so Python isn't needed for browsing.
- **pg-boss** keeps the queue in Postgres, with one less service to run.
- **Secrets in Postgres** with envelope encryption, so there's no separate vault service to run.
- **Self-hosted at home.** Browser traffic comes from a residential IP, which sites treat like a normal user.

---

## 5. LLM: Claude API

All LLM work uses the Claude API (`@anthropic-ai/sdk`). The model is chosen **per task type**, configurable in Settings (stored in DB, defaults from `.env`).

| Task | Default model | Why |
| --- | --- | --- |
| Pipeline builder (chat → definition, diffs) | **Claude Opus 5.5** (`claude-opus-5-5`) | Low volume, needs careful reasoning and correct structured output |
| Reflection (rules, pipeline improvements) | **Claude Opus 5.5** via Batch API | Runs nightly, not latency-sensitive, batch pricing |
| `email.draftReply`, `email.draftFollowUp`, `llm.generate` (CV, cover letter), `llm.summarize` | **Claude Sonnet 5.5** (`claude-sonnet-5-5`) | Writing quality in my voice, moderate volume |
| `browser.mapForm` field mapping, `browser.agent` | **Claude Sonnet 5.5** | Good speed/intelligence balance for multi-step tool use; escalate to Opus 5.5 on repeated failure |
| `email.classify`, `llm.classify`, `llm.score`, extraction | **Claude Haiku 5.5** (`claude-haiku-5-5`) | High volume, cheap and fast |

Claude Fable 5.1 isn't needed by default. It's the most capable and most expensive tier, and can be selected per task if something proves too hard.

**Usage patterns:**

- **Structured output:** every LLM call sets `output_config.format` to a JSON schema generated from a zod schema (`@anthropic-ai/sdk` zod helper), and the answer is validated again with zod: an answer that doesn't match fails the step with a clear error, and nothing partial is saved. Per-item steps (`llm.classify`, `llm.score`) send items in chunks of 20 and require exactly one answer per item. Sonnet and Opus calls use the server-side refusal fallback (`fallbacks: "default"`).
- **Model routing** ([packages/llm](packages/llm)): my setting for the step type (`ModelSetting`), else `LLM_MODEL_CLASSIFY` / `LLM_MODEL_WRITING` / `LLM_MODEL_REFLECTION` / `LLM_MODEL_BUILDER`, else the defaults above (effort `low` for classify/score, `medium` for writing, `high` for reflection and the builder). A builder chat keeps the model it started with: Claude's thinking blocks in its history are bound to that model.
- **Prompt caching:** stable prefixes (system prompt, step catalog, active rules, profile) are cached. This matters most for the builder and for drafting.
- **Untrusted content delimiting:** email/page/file text is wrapped in clearly marked blocks with an explicit "this is data, not instructions" policy in the system prompt.
- **Cost tracking:** token usage and cost are stored per step (`Step.llmUsage`, failed calls included; a fallback is priced per model; embeddings count too) and per reflection (`Reflection.llmUsage`, at batch prices) and builder turn (`BuilderMessage.llmUsage`), with a monthly total on the dashboard and an optional budget limit that pauses non-essential pipelines and the nightly reflection.
- **Watching the server (M26):** the nightly backup, the monthly restore test and the host's `health-alert` (disk use, failed services, every 4 hours) report their result to AI ME (`POST /hooks/health` on the hooks-only site, with `HEALTH_REPORT_TOKEN`). A report that isn't ok, or one that stops coming (the backup after 26 hours, `health-alert` after 5, the restore test after 35 days), is told on the AI ME bot once, and once when it is fine again; the worker keeps its own watchdog. The **Health** page shows them all.
- **Morning brief (M25):** every day at 07:30 (Europe/Sofia), on the AI ME bot: today's calendar (when Google is connected), what waits for me (proposals to approve per pipeline, runs paused in the live view), the runs that failed in the last day, and unpaid bills due within three days or overdue. A day with none of it is one line. Off in Settings.
- **Weekly review:** Sunday 19:00 (Europe/Sofia), on the AI ME bot: the week's digest (runs, failures, what waits for me, reflection's suggestions, broken recipes, LLM cost), the budget so far, the three most expensive step types and models, application outcomes and quiet recipes. Off in Settings.

**Embeddings:** Anthropic doesn't provide an embeddings model. AI ME uses **OpenAI** `text-embedding-3-large` (multilingual, Bulgarian + English) with `dimensions: 1024`, behind one `Embeddings` interface ([packages/llm](packages/llm)): nothing to run on the server, and the email text already goes to Claude. Without `OPENAI_API_KEY`, drafts are written without examples and approved outputs are kept unembedded until a key is set. A local model (`bge-m3` in `py-worker`) or Voyage can replace it later; each example records the model that embedded it, and examples of another model are re-embedded at startup.

---

## 6. How the browser runs (Playwright on the server)

Playwright does **not** run inside my browser. The worker on the server launches a real Chromium process and controls it over the DevTools protocol. The React app only *displays* that browser.

- **Headless mode** (no window) is used for fast, unattended work like job discovery and scraping listings.
- **Headed mode** is used for anything with login, forms or submissions. the server has no monitor, so Chromium draws onto a virtual display (**Xvfb**).
- **x11vnc + noVNC** stream that virtual display over a WebSocket. The React app embeds it on the Run page using the noVNC client library (`@novnc/novnc`, `RFB` class).
- **Session state per site** keeps logins between runs: after each run the worker saves Playwright `storageState` (cookies + local storage) as an encrypted `STORAGE_STATE` credential (see §7), and loads it into a fresh browser context next time. No unencrypted profile folders on disk.

### Live view & takeover

```tsx
const rfb = new RFB(containerRef.current, `wss://storm.example.com/vnc`, {
  credentials: { password: novncPassword },
});
rfb.scaleViewport = true;
rfb.viewOnly = !takeover;   // watch-only until I press "Take over"
```

- While the worker acts, the panel is **view-only**, so I can't accidentally interfere with the script.
- The worker detects blocking states (CAPTCHA iframe, 2FA prompt, unknown selector, timeout, extra required field) and switches the run to `WAITING_FOR_USER`. I get a notification and the panel becomes **interactive**.
- I click and type directly on the site, then press **Continue** (or **Abort**). The worker resumes from the current page state.
- I can also press **Take over** at any time, which pauses the worker.
- **Stop before submit** (`stopBeforeSubmit: true`) is available per pipeline for sites I don't trust yet: after I approve, the worker fills everything and stops on the final button, and I press it myself in the live view.
- **Clipboard / Cyrillic text:** VNC keymaps are unreliable for non-Latin input, so the UI has a clipboard box that pastes text into the remote browser via the noVNC clipboard API.
- **One headed run at a time** (one virtual display). Headed jobs are serialized in the queue; headless jobs can run in parallel.
- Each run stores a Playwright trace (`trace.zip`) for inspection with `npx playwright show-trace`.

During local development the worker simply runs with `headless: false`, so the browser opens on the dev machine and no Xvfb/noVNC is needed.

**How it is built** ([apps/worker/src/browser](apps/worker/src/browser), [docker/worker-entrypoint.sh](docker/worker-entrypoint.sh)):

- **Browsers:** one shared headless Chromium (a few contexts at once) and one headed slot, launched for the step and closed after. Every step gets a fresh context: the only login it has is the site's sealed storageState, loaded into memory and saved back after the step (credential `session.<host>`, kind `STORAGE_STATE`, bound to that host).
- **`browser.open`** (the first browser step; M9–M11 add the recipe and agent steps on the same layer): opens a page, signs in when it shows a password field (username and password on one page, or one after the other as SSO providers do), waits for a selector, returns the page text. `headed: true` puts it in the live view.
- **Blocking states:** a CAPTCHA (reCAPTCHA, hCaptcha, Turnstile frames and markers), a 2FA prompt, a sign-in that didn't go through, a selector that doesn't appear. The step then waits **with the page open**: a `Takeover` row (`OPEN`, or `TAKEN_OVER` when I pressed Take over, picked up at the step's next safe point), the run shows `WAITING_FOR_USER` (no other job can claim it meanwhile), the inbox lists it and Telegram says "AI ME needs you". Continue goes on from the page as I left it; Abort stops the run; nobody within `TAKEOVER_TIMEOUT_MINUTES` fails the step; the kill switch stops it. After a restart the page is gone: the takeover expires and the step runs again. A headless step can't be taken over: it fails with the reason.
- **Live view security:** Caddy lets `/vnc` through only for a signed-in session (`forward_auth` to the api), and x11vnc (on localhost inside the container, reached through websockify) asks for its own password. The api hands out the **view-only** one (x11vnc ignores input on it) while the worker acts, and the full one only while a takeover is open. Checked in the real container: typing with the view-only password changes nothing.
- **Nothing secret in what it keeps:** the page text and any snapshot for the LLM have every filled value masked (also URL-, form- and JSON-encoded); screenshots cover password fields and the fields it filled; the Playwright trace is rewritten with credential values, cookie values and stored tokens masked, and dropped if anything is still found. storageState is never written to a file.
- **Downloads and uploads** (M11): `browser.download` takes the address itself, or what a click on that page downloads, through the quarantine below; `browser.upload` (side effect, behind its gate) puts one stored document, bound by id and SHA-256 (from `file.read`), into a file field on the allowed sites.
- **Files:** screenshots, traces and accepted downloads are `Artifact`s under `ARTIFACTS_DIR` by run, served to me by the api (images inline, everything else as a download, with `Content-Security-Policy: sandbox`). Downloads go to a quarantine folder first: kept only within `DOWNLOAD_MAX_MB` and when their content (magic bytes) matches an allowed type for their extension (PDF, images, Office documents, text); anything else is deleted.

---

## 7. Secrets: encrypted in PostgreSQL

Same approach as Infisical: **envelope encryption** with a root key from the environment.

- **Root key (KEK):** `ENCRYPTION_KEY` in `.env`, 32 random bytes (`openssl rand -hex 32`; base64 also accepted).
- **Data key (DEK) per secret:** each value is encrypted with its own random DEK. The DEK is encrypted ("wrapped") with the root key and stored in the same row.
- **Algorithm:** AES-256-GCM (`node:crypto`, no external dependencies). GCM detects tampering.
- **AAD = record ID:** ciphertext is bound to its row, so an encrypted password can't be swapped from one credential row to another.
- **Key versioning:** `keyVersion` per row. Rotation means adding `ENCRYPTION_KEY_V2` and re-wrapping DEKs, without re-encrypting values.

### What it protects against

- **Protects:** leaked DB dumps or backups, access to the Postgres volume, and SQL access without the key.
- **Does not protect:** root access to the server, since `.env` and DB are on the same host. The defenses for that are Tailscale-only access, TOTP on the UI, and keeping the host patched. The same applies to `APP_TOTP_SECRET`, which also lives in `.env`; this is accepted under this threat model.

### Rules

- **Only the worker decrypts,** at the moment of `fill()`. The API only encrypts on create/update.
- **Credentials are write-only in the UI.** Values are never returned by the API. There's a "Replace" button, and optionally "Reveal" protected by TOTP.
- **Never sent to the LLM, logs, traces or screenshots.** Pipelines and proposals contain only `{{cred:<name>}}`. Password fields are filled last and masked in traces where possible.
- **Masked for the LLM:** before an accessibility snapshot or screenshot is sent to the LLM (e.g. by `browser.agent`), the worker strips `input[type=password]` values and every field it filled from a `{{cred:*}}`, and blurs those fields in screenshots.
- **Domain binding:** the worker refuses to fill a credential on a page whose host isn't in the credential's `allowedHosts` (exact host match, or an explicit `*.example.com` wildcard; never substring matching). Multiple hosts cover SSO redirects. This protects against phishing pages and prompt-injected redirects.
- **Same mechanism for** the IMAP app password (later the Gmail refresh token), TOTP seeds, API keys, and Playwright `storageState`.
- **Back up `ENCRYPTION_KEY` separately from DB backups** (personal password manager or printed). Losing the key loses every secret; storing it next to the backups defeats the encryption.

### Implementation (`packages/crypto`)

[packages/crypto/src/envelope.ts](packages/crypto/src/envelope.ts) and [key-ring.ts](packages/crypto/src/key-ring.ts):

- `seal(keys, id, secret)`: random 32-byte DEK, AES-256-GCM with AAD = row id, DEK wrapped with the current root key version. Returns `ciphertext`, `iv`, `authTag`, `wrappedDek` (iv 12 + tag 16 + DEK 32 bytes) and `keyVersion`.
- `open(keys, id, sealed)`: unwraps with the row's `keyVersion`, decrypts; throws on any tampering, wrong id or missing key version.
- `rewrap(keys, id, sealed, toVersion)`: moves the DEK to another root key version without decrypting the value (`pnpm keys:rotate`).
- `KeyRing.fromEnv()`: `ENCRYPTION_KEY` is version 1, `ENCRYPTION_KEY_V<n>` later versions, `ENCRYPTION_KEY_VERSION` selects the one new secrets are sealed with. Keys are 32 bytes as 64 hex characters or base64.
- The api imports only `seal` (enforced by ESLint `no-restricted-imports`); `open` and `rewrap` are used only in the worker ([apps/worker/src/secrets/](apps/worker/src/secrets/)).

**Future hardening (optional):** the API wraps DEKs with a *public* key (X25519 / RSA-OAEP) and only the worker holds the private key. A compromised API process could then store secrets but never read them. `keyVersion` allows migrating to this later.

---

## 8. Learning from my decisions

1. **Decision capture.** Every proposal stores `originalPayload` and `finalPayload` plus a diff, a decision (`APPROVED`, `EDITED`, `REJECTED`) and an optional reason.
2. **Few-shot retrieval.** When I approve a proposal (as drafted or edited), each payload field that is exactly the output an LLM step writes for me (`{{draft.body}}`; the catalog marks it with `learns`) becomes an `Example` of that step type: the step's input (the incoming email) as context, my approved text as output, embedded with pgvector. When drafting, `email.draftReply` and `llm.generate` retrieve my 3 most similar approved outputs of the same step type (cosine distance) as `<examples>`: tone, length and structure, never facts.
3. **Rules.** A nightly reflection (03:30 Europe/Sofia; also "Reflect now" on the Rules page) sends my edits and rejections since the last one to Claude Opus through the Batch API and **suggests** rules ("Shorten recruiter replies; drop 'I hope this finds you well'"). Suggestions are checked (known step types, my own pipelines, no duplicates) and saved as `SUGGESTED`; nothing is active before I approve or edit it on the Rules page. Active rules go into the cached system prompt of every LLM step of their step type (or every step) and pipeline (or every pipeline), after the step's own rules, which they never override.
4. **Pipeline improvements.** Reflection can also suggest a change to a pipeline (tighter filter, different threshold); it is listed on the Rules page and in that pipeline's chat, where "Turn into a change" has the builder make it a diff for approval. Saving that diff marks the suggestion done.
5. **Run feedback.** After each run and in the daily digest: failure patterns, selectors that broke, rules worth adding.

There's no fine-tuning. Everything learned is visible and editable.

---

## 9. Data model

The schema is [packages/db/prisma/schema.prisma](packages/db/prisma/schema.prisma) (Prisma 7.10.0, PostgreSQL 17 + `pgvector` + `citext`). Conventions:

- Primary keys are named `<entity>Id` (uuid); timestamps are `dateCreated` / `dateUpdated`; tables are PascalCase plural (`@@map("Users")`).
- Every user-owned table carries a non-null `userId` from day one (single user for now; Postgres row-level security later, see §17). Child tables owned through their parent (`PipelineVersions`, `Steps`, `Decisions`, `BuilderMessages`, `Takeovers`) don't; an integration test enforces this.
- `Credential.credentialId` is generated before insert because it is the AAD of the encrypted value (§7).

| Area | Models |
| --- | --- |
| Identity | `User`, `UserSession` (cookie token stored as SHA-256 only) |
| Pipelines | `Pipeline` (`enabled`: on its schedule; `essential`: exempt from the budget), `PipelineVersion` (`definition`, compiled `policy`, the `builderChatId` it came from), `BuilderChat` (model, tokens used), `BuilderMessage` (transcript, proposal, cost), `SiteRecipe` |
| Runs | `Run` (`resumeAt` when held back by a rate limit), `Step`, `Proposal` (linked to its gate `Step` and `forEach` item), `Decision`, `Takeover` (the live browser waiting for me), `Artifact` (screenshots, traces, downloads) |
| Learning | `Rule`, `Example` (`embedding vector(1024)`) |
| Secrets & settings | `Credential` (envelope-encrypted, `allowedHosts`), `ModelSetting`, `UserSetting` (kill switch, global rate limits, budget) |
| Jobs | `JobPosting`, `Application`, `Document` (my CV and cover letters, under `DOCUMENTS_DIR`; replaced by name, old files kept for approved payloads) |

---

## 10. Repository layout

```text
ai-me/
├─ apps/
│  ├─ api/            # NestJS: REST + WebSocket, Prisma
│  │  └─ src/
│  │     ├─ builder/      # chat → pipeline definition (LLM + step catalog), diffs, dry runs
│  │     ├─ pipelines/    # pipelines, versions, enable/schedule
│  │     ├─ runs/  proposals/  decisions/  rules/  recipes/  jobs/  artifacts/
│  │     ├─ credentials/  # create / replace / delete (encrypt only, never returns values)
│  │     ├─ controls/     # kill switch, settings (global rate limits, budget)
│  │     ├─ settings/     # model routing
│  │     ├─ auth/         # single-user auth (password + TOTP)
│  │     └─ events/       # WebSocket gateway: run progress, WAITING_FOR_USER
│  ├─ worker/         # NestJS standalone: queue consumers
│  │  └─ src/
│  │     ├─ runner/        # interprets PipelineVersion, resume, retries, gates; policy guard; kill switch, rate limits, budget
│  │     ├─ jobs/          # pg-boss consumers: runs, scheduled triggers, schedule sync, recovery at startup
│  │     ├─ steps/         # one class per step type (email.*, browser.*, llm.*, data.*, file.*, gate.*, notify.*)
│  │     ├─ connectors/    # MailConnector (imap/smtp, later gmail api), job sources
│  │     ├─ browser/       # Playwright sessions, storageState, recipes, agent, takeover, CAPTCHA detection
│  │     ├─ secrets/       # decrypt + {{cred:*}} resolution + domain binding + LLM masking
│  │     └─ reflection/    # nightly rule + pipeline-improvement suggestions
│  ├─ web/            # React + Vite
│  │  └─ src/pages/   # Builder, Pipelines, PipelineDetail (chat + diff), Inbox, ProposalDetail,
│  │                  # RunDetail (live view), History, Rules, Recipes, Jobs, Credentials, Settings
│  └─ web-e2e/        # Playwright browser tests against the composed stack (test-only steps stand in for side effects)
├─ packages/
│  ├─ config/         # shared tsconfig + eslint configs
│  ├─ db/             # Prisma schema, migrations, seed, generated client (src/generated)
│  │  ├─ prisma/schema.prisma
│  │  └─ prisma.config.ts
│  ├─ shared/         # DTOs, enums, zod schemas (pipeline definition, payloads)
│  ├─ steps/          # step catalog metadata: names, input/output schemas, side-effect flags
│  ├─ llm/            # Claude client, model routing, caching, tool-use structured output
│  ├─ crypto/         # envelope encryption (seal / open / rewrap, key ring)
│  ├─ queue/          # pg-boss queues (shared by api and worker), cron schedule helpers
│  └─ testing/        # integration-test infrastructure: PostgreSQL (Testcontainers or local), migrate + seed
├─ pipelines/         # hand-written pipeline definitions (YAML) to paste into the web app; a test keeps them compiling
├─ py-worker/         # optional: local embeddings, OCR
├─ docker/
│  ├─ docker-compose.yml
│  └─ worker/         # Dockerfile: Playwright image + Xvfb + fluxbox + x11vnc + noVNC
├─ package.json       # turbo scripts (dev, build, lint, typecheck, test, db:*)
├─ pnpm-workspace.yaml  # workspaces + version catalog
├─ turbo.json
├─ .env.example
└─ README.md
```

Monorepo setup: **pnpm** workspaces with a version **catalog** in `pnpm-workspace.yaml` (packages use `"catalog:"`), **Turborepo** for tasks, internal packages via `workspace:*`. **Prisma 7.10.0** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`), with the schema and client in `packages/db`.

---

## 11. Rollout (MVP order)

### Phase 0: Foundation

- Monorepo, Prisma schema, crypto package, auth.
- Pipeline definition schema + runner with a minimal step set (`data.*`, `llm.*`, `gate.*`, `notify.*`).
- Pipelines are **hand-written YAML** (loaded from files or pasted into the UI), validated by the same zod schema, with a review screen and dry run.
- Proposal inbox, policy layer, rate limits, kill switch.

### Phase 1: Email triage + reply drafts

- Steps: `email.fetch`, `email.classify`, `email.draftReply`, `gate.act`, `email.send` via IMAP/SMTP (`MailConnector`).
- Hand-written pipeline: "Every 15 minutes, check new mail; draft replies for anything from recruiters or clients."
- Edits are captured, so the learning loop starts here.

### Phase 1.5: Builder chat

- Chat → definition compiler (§2.1), diffs, pipeline-bound chat (§2.5).
- Built after 2–3 real pipelines have been written by hand, so the definition format is stable and the builder has known-good targets to produce. Safety doesn't depend on it: the runner only ever executes validated definitions.

### Phase 2: Job discovery + scoring

- Steps: `browser.extract` (headless, recipes), `data.dedupe`, `llm.classify`, `llm.score`, `gate.review`, `notify.digest`.
- Teach mode for the first recipes. No submissions in this phase.

### Phase 3: Application preparation

- Steps: `llm.generate` / `file.generate` (CV + cover letter), `browser.mapForm`, `gate.act`, `browser.fillAndSubmit` (headed, optional stop before submit).
- Live view + takeover required (worker image with Xvfb + noVNC).

### Phase 4: Generic forms, uploads, downloads, `browser.agent`

- Bounded browser agent for sites without recipes, with fallback from broken recipes.

> Large job platforms (e.g. LinkedIn) forbid automation in their terms. Use them for discovery via my own manual browsing or alerts only, and apply manually or on simpler company/ATS pages.

---

## 12. Reporting

- **Run page**: live view (only a step that opens a window draws on the display: teach mode, `browser.submit`, `browser.fillAndSubmit`, a step with `headed: true`, or one waiting for me; while a step works in the hidden browser, or between steps, the live view says so and shows the latest screenshot instead of an empty desktop), step timeline (per `forEach` item), screenshots, payloads, results, LLM usage, trace download. A failed run has **Retry from the failed step**: the failed steps run again, those before keep their outputs (no LLM call paid twice) and nothing that ran is repeated; not when a side effect failed (or was left running), since it may have gone out: that is a new run, after I checked.
- **Cost**: each run's LLM cost in the runs lists; on the pipeline page, its last 30 days (spent, runs, per run) and, for a schedule, about what a month costs (per run × how often it fires); enabling a schedule asks first, with that estimate.
- **Costs** (M28): every run of the last 7, 30 or 90 days and what it cost; per pipeline, its steps by share of the cost with model, calls per run and tokens per call (input, output, cache); a run opens to its steps. **Copy report** puts it all, with the model each task uses, on the clipboard as Markdown, to paste into a chat about cutting costs; **JSON** downloads the raw runs.
- **Pipeline pages** (M27): under Pages in the menu, one per pipeline with a `view`: its rows by tab (current, each mark, removed), searched, a row's own page with its history chart, my marks, its buttons. Jobs, Bills and Prices keep their own pages.
- **Insight**: the job search in numbers (M16): found, applied, replied, interviews, rejections, by source and score band.
- **History**: filter by pipeline, version, status, date, target.
- **Daily digest** (email or Telegram): what ran, what's waiting for me, failures, suggested rules and pipeline changes.
- **Notifications** when a run enters `WAITING_FOR_USER`: the AI ME bot, with Approve / Reject / Open on each proposal (§2.7).

---

## 13. Deployment on the server

`docker/docker-compose.yml` (outline):

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: aime
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: aime
    volumes: [pgdata:/var/lib/postgresql/data]

  api:
    build: ../apps/api
    env_file: ../.env            # needs ENCRYPTION_KEY (encrypt only), ANTHROPIC_API_KEY (builder)
    depends_on: [postgres]

  worker:
    build: ./worker              # Playwright + Xvfb + fluxbox + x11vnc + noVNC
    env_file: ../.env            # needs ENCRYPTION_KEY (decrypt), ANTHROPIC_API_KEY
    environment:
      DISPLAY: ":99"
    depends_on: [postgres]
    volumes:
      - artifacts:/data/artifacts
    # noVNC listens on 6080 — reachable only via the reverse proxy on the tailnet
    shm_size: "1gb"              # Chromium needs more than the 64MB default

  web:
    build: ../apps/web           # static build served by caddy/nginx
    # also proxies /api → api:3000 and /vnc → worker:6080

  # py-worker:                   # optional: local embeddings
  #   build: ../py-worker

volumes: { pgdata: {}, artifacts: {} }
```

Expose services only on the Tailscale interface (Caddy with Tailscale HTTPS certs in front). No public ports.

The real setup follows the server's conventions (native PostgreSQL, `tailscale serve`, the existing nightly backup): [docker/compose.yml](docker/compose.yml), images from [docker/Dockerfile](docker/Dockerfile), run with [docker/aime](docker/aime). Install, updates, restore and checks: [docs/deployment.md](docs/deployment.md).

---

## 14. Environment variables (`.env.example`)

```text
# Database
DATABASE_URL=postgresql://aime:change-me@postgres:5432/aime
POSTGRES_PASSWORD=change-me

# Encryption — 32 random bytes: openssl rand -hex 32 (or -base64 32)
# BACK THIS UP SEPARATELY. Losing it = losing all stored credentials.
ENCRYPTION_KEY=
ENCRYPTION_KEY_VERSION=1

# LLM (Claude API) — defaults; overridable per task in Settings
ANTHROPIC_API_KEY=
LLM_MODEL_BUILDER=claude-opus-5-5
# A builder chat stops once its calls used this many tokens (cache reads included); a new chat starts over
BUILDER_CHAT_MAX_TOKENS=2000000
LLM_MODEL_REFLECTION=claude-opus-5-5
LLM_MODEL_WRITING=claude-sonnet-5-5
LLM_MODEL_BROWSER=claude-sonnet-5-5
LLM_MODEL_CLASSIFY=claude-haiku-5-5
# Non-essential pipelines pause when this month's LLM cost reaches it; Settings override it; empty = no limit
LLM_MONTHLY_BUDGET_USD=

# Embeddings for few-shot examples (OpenAI, 1024 dimensions); empty key = drafts without examples
OPENAI_API_KEY=
EMBEDDINGS_MODEL=text-embedding-3-large

# Mail: v1 uses IMAP/SMTP with a Google app password, stored encrypted in the DB (not here): a credential named
# MAIL_CREDENTIAL (username = the address; allowed hosts = imap.gmail.com, smtp.gmail.com)
MAIL_CONNECTOR=imap
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
# TLS from the first byte; "false" only for a local test server
MAIL_TLS=true
MAIL_CREDENTIAL=mail
# Later, Gmail API (OAuth app; refresh token stored encrypted in the DB)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=

# API
API_HOST=127.0.0.1
API_PORT=3000
# The address the browser uses behind a proxy (server: https://storm.example.com:8100)
APP_ORIGIN=

# App auth (single user): pnpm auth:setup prints the hash and a new TOTP secret
APP_ADMIN_EMAIL=me@localhost
APP_ADMIN_PASSWORD_HASH=
APP_TOTP_SECRET=
SESSION_TTL_HOURS=168

# Browser / live view (the worker image sets DISPLAY=:99 and ARTIFACTS_DIR=/data/artifacts)
# My documents (CV, cover letters) that application forms attach: the api writes, the worker only reads
DOCUMENTS_DIR=data/documents
# Run files (screenshots, traces) older than this are deleted nightly; 0 keeps them. On the server both folders are on the
# secondary disk (/data/ai-me, docker/compose.yml)
ARTIFACTS_RETENTION_DAYS=90
# x11vnc's passwords: full control, and view-only (input ignored); VNC uses the first 8 characters. Empty: no live view
VNC_PASSWORD=
VNC_VIEW_PASSWORD=
# A run waiting for me in the live view gives up after this long; downloads over this size are rejected
TAKEOVER_TIMEOUT_MINUTES=30
DOWNLOAD_MAX_MB=25
# Headed runs are always one at a time (one display): the runs-headed queue is a pg-boss singleton queue

# The AI ME bot (§2.7): token, my Telegram user id, the secret Telegram sends with each update
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
# Public address of the webhooks (shown on the pipeline page)
HOOKS_PUBLIC_URL=https://hooks.example.com/aime
# the server's own jobs reporting to the Health page (M26)
HEALTH_REPORT_TOKEN=
```

---

## 15. Local development

```bash
# prerequisites: Node 22.12+ or 24, pnpm 10, Docker
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres
pnpm db:migrate                # prisma migrate dev in packages/db
pnpm --filter @ai-me/worker exec playwright install chromium

pnpm dev                       # turbo: api, worker (headless: false → browser opens on the dev machine), web

pnpm test                      # unit tests (Jest; Vitest for web)
pnpm test:e2e                  # integration tests: PostgreSQL in Testcontainers (E2E_INFRA=local: a temporary database)
pnpm --filter @ai-me/web-e2e exec playwright install chromium
pnpm test:web                  # browser tests (Playwright) against the composed stack: database, api, worker, web
pnpm --filter @ai-me/worker eval:email   # LLM evals (real Claude API, ~$0.13): email triage accuracy, reply drafts
```

**Mail (Phase 1):** in Gmail, turn on 2-step verification and create an app password. On the Credentials page add a
`password` credential named `mail` with the Gmail address as username, the app password as secret, and allowed hosts
`imap.gmail.com, smtp.gmail.com`. Then paste [pipelines/recruiter-replies.yaml](pipelines/recruiter-replies.yaml) on
the Pipelines page, dry run, save and enable. Every reply waits in the inbox until I press Act.

---

## 16. Security checklist

- [ ] No public ports, Tailscale only; the VPS's hooks-gateway reaches only the hooks-only site (`POST /hooks/*`)
- [ ] Single-user auth with TOTP on the web UI
- [ ] `ENCRYPTION_KEY` only in `.env`, backed up separately from DB backups
- [ ] Credentials: encrypted with AES-256-GCM envelope encryption, AAD = row ID, write-only via API
- [ ] Only the worker decrypts; values never in logs, prompts, traces or screenshots
- [ ] Domain binding: credentials filled only on hosts in `allowedHosts` (exact or explicit wildcard)
- [ ] Credential values and filled credential fields masked in snapshots/screenshots sent to the LLM
- [ ] Pipelines built only from the step catalog; definitions validated with zod
- [ ] Gates auto-inserted before every side-effect step; not removable in v1
- [ ] External forms use map → gate → act; attaching a file counts as an upload
- [ ] Policy layer enforces static and provenance-based targets; new domains flagged at the gate
- [ ] Per-step-type rate limits; kill switch pauses everything and cancels queued side effects
- [ ] Executed payload must match the hash of the approved payload
- [ ] Untrusted content (email/page/file text) is clearly delimited in prompts and never treated as instructions
- [ ] `shop.product` reads like `http.fetch`, and its browser pages go only to allowed hosts
- [ ] Google Calendar's refresh token is sealed like a credential (AAD: my user id) and opened only by the worker; a refused connection pauses the run for a reconnect instead of failing it
- [ ] Facts about me are written only by my approvals, my answers and the Profile page, never by a page or the LLM alone; a fact the LLM cites must be mine, with my answer
- [ ] `calendar.create`'s guests can't come from LLM output (they are recipient targets), and Google emails them only after Act
- [ ] Browser pages that explore or act (agent, upload, submit, shop.product) go only to allowed sites, every redirect checked before it is followed
- [ ] `http.fetch` reads only hosts on the pipeline's allowedDomains and connects only to public addresses (checked after DNS, on IP literals and every redirect; no cookies or credentials)
- [ ] Telegram and webhook calls carry their own secret (bot header + my user id; per-pipeline HMAC or token); signatures checked by the worker; a webhook body is never a target
- [ ] `browser.agent` limited by domain allowlist, action budget and fixed action set; it submits and uploads nothing
- [ ] noVNC password-protected, view-only by default
- [ ] Downloads go to a quarantine folder; type and size checked before processing
- [ ] Playwright `storageState` stored only as encrypted credentials; no plaintext profile folders
- [ ] LLM monthly budget limit
- [ ] Backups: Postgres dump + artifacts (+ key stored elsewhere)
