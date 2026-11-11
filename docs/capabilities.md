# Capabilities: what Storm can do, and every step type

Storm runs **pipelines**: short lists of steps, written in YAML (by hand, or by the pipeline builder from a chat
message), that read things, think about them with the LLM, and act only after you approve. A pipeline can do only what
its steps can do, and it can use only steps from the **step catalog** below. The LLM never invents new capabilities;
a new capability is a new step written in code ([packages/steps/src/catalog.ts](../packages/steps/src/catalog.ts)
is the source of truth, the implementations are in [apps/worker/src/steps/](../apps/worker/src/steps/)).

Ready-made pipelines to copy are in [pipelines/](../pipelines/). This document explains the building blocks.

---

## 1. At a glance

| Area | What it can do | Steps |
| --- | --- | --- |
| Lists of data | Deduplicate, filter, save and compare with last time, read back an App's entities, track a number over time, reshape an API's JSON, tell once when a number crosses a line | `data.dedupe`, `data.filter`, `data.save`, `data.read`, `data.history`, `data.map`, `data.alert` |
| Databases | Read your own PostgreSQL database with one query, read-only | `db.query` |
| The web without a browser | Read RSS/Atom feeds, JSON APIs (with a key) and pages; change something at an API after you approve; read product prices | `http.fetch`, `http.request`, `shop.product`, `price.watch` |
| LLM | Label, score, write, summarize, pull fields out of text | `llm.classify`, `llm.score`, `llm.generate`, `llm.summarize`, `llm.extract` |
| Email | Read new mail, triage it, draft replies, find unanswered emails, draft follow-ups, send | `email.fetch`, `email.classify`, `email.draftReply`, `email.awaiting`, `email.draftFollowUp`, `email.send` |
| Topics | Sort email into the subjects you keep a memory of (a project, a customer), and keep what is true about each, with your approval; read their documents where they live (GitHub, Google Drive) for drafts to quote | `topic.match`, `topic.extract`, `topic.apply`, `git.changes`, `drive.changes`, `topic.index`, `topic.attachments` |
| Job hunting | Track what employers answered to your applications | `application.outcome` |
| Bills | Read bills from emails and their PDFs, keep them, flag unusual amounts | `bill.read`, `bill.save` |
| Google Calendar | Find events, create events (with invites and Meet links) | `calendar.find`, `calendar.create` |
| Browser | Open pages (with sign-in), read lists with recipes, teach recipes, read and fill forms, let an agent work a page, download and upload files | `browser.open`, `browser.extract`, `browser.teach`, `browser.mapForm`, `browser.fillAndSubmit`, `browser.agent`, `browser.submit`, `browser.download`, `browser.upload` |
| Documents | Read a stored document or a downloaded file | `file.read` |
| You in the loop | Pick items from a list, approve an action | `gate.review`, `gate.act` |
| Telling you | A Telegram message, a digest | `notify.telegram`, `notify.digest` |
| Timing | Start another pipeline later, cancel it | `flow.later`, `flow.cancel` |

---

## 2. How a pipeline is written

```yaml
name: Release watch                      # unique, used by /run, flow.later and run.finished
description: New releases, summarized.   # optional
trigger: { schedule: "0 9 * * *", tz: Europe/Sofia }   # see §3; default: manual
policy:
  allowedDomains: [github.com]           # hosts the pipeline may read from or act on
  allowedRecipients: []                  # extra email addresses it may send to
limits:
  email.send: 10/day                     # at most N runs of a step type per hour or day
steps:
  - id: feeds                            # letters, digits, _; used in references
    type: http.fetch                     # a step type from the catalog
    with: { url: https://github.com/nodejs/node/releases.atom }
  - id: tell
    type: notify.telegram
    when: "{{feeds.items}}"              # skip the step when the value is empty
    with: { text: "{{feeds.items}}" }
view: ...                                # optional: a page in the menu for a saved collection (§2.4)
```

### 2.1 References

A step's inputs can use the outputs of earlier steps:

| Reference | Meaning |
| --- | --- |
| `{{search.items}}` | The `items` output of the step with id `search` |
| `{{invite.values.start}}` | A nested field |
| `{{item}}`, `{{item.url}}` | The current item, inside a step with `forEach` |
| `{{trigger.message.from}}` | Data from the event or webhook that started the run (§3) |
| `{{cred:jobs-bg}}` | A stored credential (only in `browser.open`'s `login`) |

A value that is **exactly** one reference passes the value as it is (a list stays a list). A reference inside text
(`"Hello {{item.fromName}}"`) is turned into text. The compiler checks every reference and its type before the
pipeline can be saved.

### 2.2 `forEach`, `when`, `retries`

- **`forEach: "{{triage.kept}}"`** runs the step once per item. Several steps that loop over the same list stay
  aligned: inside the loop, `{{draft.body}}` is the draft for *this* item.
- **`when: "{{save.added}}"`** runs the step only when the value is not empty (a non-empty list or text, `true`, a
  number other than 0, an object). A skipped step also skips the later steps that use its output. Inside `forEach`,
  `when` is checked per item.
- **`retries: 2`** retries a failed step up to 5 times. Side-effect steps are never retried.

### 2.3 Safety rules the compiler enforces

- **Every side effect waits for you.** `email.send`, `calendar.create`, `browser.fillAndSubmit`, `browser.upload` and
  `browser.submit` always get a `gate.act` before them. If you don't write one, the compiler inserts it. The run pauses
  and shows the exact payload (recipient, subject, body, form fields). Nothing goes out until you press **Act**, in the
  app or on Telegram.
- **Targets never come from LLM text.** The recipient of an email, the guests of an event and the address of a form
  must come from real data: the sender of a fetched email, a posting's own URL, a literal in the pipeline, or
  `policy`. `to: "{{draft.body}}"` is rejected.
- **Domains are allowlisted.** `http.fetch`, `shop.product` and the browser steps only go to hosts the pipeline names
  in `policy.allowedDomains` (or a host literally written in the step). Private and VPN addresses are never read.
- **Credentials only go to the browser.** `{{cred:…}}` is accepted only by `browser.open`'s `login`, and only on the
  hosts the credential allows. LLM steps never see one.
- **Budget.** Steps that call the LLM stop once the monthly LLM budget is spent, unless the pipeline is marked
  *essential*.
- **One headed browser.** Runs that use the watchable (headed) browser run one at a time.
- **Dry run.** Every pipeline can be dry-run first: it reads for real, but sends, saves and schedules nothing.
  On the editor's cards, *Try up to here* dry-runs it up to one step: the steps after it don't run, the step shows what
  it gave, and the cards after it pick from that.

### 2.4 A page for the pipeline (`view`)

> M33: an App's pages (§2.5) do all of this and more; Release watch and Table growth are now in the Releases and
> Tables Apps ([pipelines/apps/](../pipelines/apps/)). `view` still works, until it goes with the old pages.

A pipeline that saves a collection (`data.save` with `collection:`) can show it as a page in the menu, with columns,
marks (e.g. *Done*, which hides a row) and buttons that start a pipeline for a row:

```yaml
view:
  menu: { label: Releases, icon: package }
  collection: releases
  columns: [title, { field: published, as: date }, { field: source, label: Feed, as: link }]
  link: url
  sort: -published
  marks: [{ id: upgraded, label: Upgraded, hides: true }]
  actions:
    - { label: Check now, run: self }
    - { label: Upgrade notes, run: Release notes, row: true, confirm: "Send this release's notes to Telegram?" }
```

With a `data.history` step, `chart` draws its values above the list, a line per key (the five with the highest latest
value; every key's own page charts it too). `stepped: true` for prices, which hold until the next reading:

```yaml
view:
  menu: { label: Tables, icon: chart }
  collection: tables                     # the latest count per table (data.save)
  columns: [name, { field: rows, as: number }]
  sort: -rows
  detail: { history: table-rows }        # a table's own page: its chart
  chart: { history: table-rows, label: Rows }
```

### 2.5 Apps and data types

An **App** (the Apps page) groups what belongs together, Job Search or Bills, and declares the shape of its data as
**types**. A pipeline joins an App with `app:`; its `data.save { type }` writes entities of a type, `data.read`
reads them back and `{ on: entity.changed }` starts it when one changes. The compiler checks every field they name
against the App, so `{{item.salery}}` is refused when the pipeline is saved, not found out on a page.

```yaml
name: Job Search
icon: briefcase
types:
  Job:
    key: url                     # one entity per url
    title: title
    fields:
      url: { type: url, required: true }
      title: { type: text, required: true }
      salary: { type: money, currency: currency }
      currency: { type: text }
      status: { type: enum, values: [new, applied, rejected] }
      favorite: { type: yesno, mine: true }     # set by you; pipelines never write it
```

- **Kinds:** `text`, `longtext`, `number`, `money` (with `currency`: the field holding its code), `date`,
  `datetime`, `url` (http(s) only), `email`, `yesno`, `enum` (with `values`), `list`. A field may be nested by a
  dotted name (`company.name`).
- **Writing:** each field is read as its kind (`"4 500"` → 4500, an ISO date and time → its date); a wrong one is
  left out and said in `invalid`; an item without a required field, or without its key, isn't saved. What the type
  doesn't name is kept with the entity as it came.
- **`mine: true`:** a field you set; no pipeline can write it, and every save keeps it.
- **Versions:** each save of an App is a new version, with what changed. A version that would break one of its
  pipelines (a type, field or name they use gone) is refused, naming each pipeline and why.
- **A type from a source:** on the App's editor, *Try the source* dry-runs a pipeline and drafts a type from a
  step's items: each field's kind from its values, without the LLM. A draft to rename and trim before saving.

**Pages.** Every type gets a list in the menu (under *Pages*) and a page per entity, by default from its fields: the
title, the required fields and the others that fit a row; enum and yes/no fields as filters; text fields searched;
newest first. A field's kind sets its format (money with its currency, an enum as a badge, a url as a link). `pages`
changes them:

```yaml
pages:
  - list: Bill
    menu: { label: Bills, icon: receipt }    # or menu: false
    columns: [payee, amount, due, status]
    filters: [status, paid]                  # enum and yes/no fields
    sort: -due
    group: { by: due, period: month, totals: [amount] }   # a group per month, its amounts summed per currency
    removed: true                            # a Removed tab
  - view: Bill
    sections:
      - { title: Payment, fields: [amount, due, status] }
    history: { collection: bill-amounts }    # a data.history collection, by the entity's key, as a chart
```

**Stages, forms and buttons (M32).** A type may have a stage: where an entity is (new, favorite, applied…), moved
only as its `moves` allow and by whom: you on its page (the default), or a pipeline's `data.save` (`by: [me,
pipeline]`, where `me` is you). A move a pipeline may not make is said in `invalid` and the stage stays, so an
email re-read never moves a job back. The date each state was first reached is kept. Your fields (`mine: true`) are edited on the entity's form;
a whole type can be yours (`mine: true` on the type: you add, edit and delete its entities, pipelines only read it).
Buttons start pipelines: a list's (a manual or scheduled one), an entity's (one triggered by `{ on: entity.action }`,
with the entity), shown only while its `when` holds.

```yaml
types:
  Job:
    key: url
    stages:
      field: status
      initial: new
      states: [new, favorite, applied, interview, rejected]
      moves:
        - { from: new, to: [favorite, applied, rejected] }
        - { from: [applied, interview], to: [interview, rejected], by: [me, pipeline] }
    fields:
      url: { type: url, required: true }
      comments: { type: longtext, mine: true }
  Company:
    mine: true                               # you write it; its email may be a side effect's target
    key: name
    fields: { name: { type: text, required: true }, email: { type: email } }
pages:
  - form: Job
    fields: [comments]
  - view: Job
    actions:
      - { label: Apply, run: Job submit, when: { status: favorite }, confirm: "Apply to this job?" }
  - list: Job
    actions: [{ label: Check now, run: Job Search collect }]
```

A target (an address to send to) never comes from a type pipelines write; from a `mine` type it may.

A list can also draw a `data.history` collection keyed by its entities above it (`chart: { history, label?, stepped? }`,
the five with the highest latest value), and *Move them here* on an App's page brings a pipeline's collection (a
`view:` page's) into one of its types: a mark on a row becomes the `mine` yes/no field of its name.

**From a sentence (M34).** The pipeline builder proposes a whole App ("I'm looking for a job", "keep my bills") with
its pipelines, as one proposal to review and save together; *Describe a change* on an App's page asks it to change
one ("add a rating to jobs"), shown as what changes in the App and in each pipeline. It starts a type from the
schema.org type that means the same and, after a dry run, drafts it from what the source really gave. **In the data,
not in the types** on an App's page lists the fields its entities have that their type doesn't name, with *Add to the
type*.

Ready-made Apps in [pipelines/apps/](../pipelines/apps/): Job Search, Bills, Prices, Releases, Tables, Trips, Clients, Apartments, Orders, Subscriptions, Car, Server ops. Job Search
([pipelines/apps/job-search.yaml](../pipelines/apps/job-search.yaml)) is filled by a job-board pipeline
([job-board.yaml](../pipelines/job-board.yaml): `browser.extract` with a recipe like
[recipes/example-jobs.yaml](../recipes/example-jobs.yaml), the agencies skipped, the rest scored, then `data.save` with
`type: Job`) and by [application-replies.yaml](../pipelines/application-replies.yaml). Save the App before its
pipelines.

---

## 3. Triggers: what starts a pipeline

| Trigger | Starts when | `{{trigger.*}}` holds |
| --- | --- | --- |
| `manual` (default) | You press Run, or send `/run <name>` on Telegram | — |
| `{ schedule: "0 8 * * 1-5", tz: Europe/Sofia }` | A five-field cron time | — |
| `{ on: run.finished, pipeline: Bills, status: [FAILED] }` | Another pipeline's run ends (default: only `DONE`) | `runId`, `pipeline`, `status`, `summary`, `outputs` |
| `{ on: application.status, status: [SUBMITTED] }` | One of your applications changes status | `applicationId`, `status`, `job` (title, company, location, url) |
| `{ on: recipe.broken, site: jobs.example.com }` | A browser recipe stops matching its site | `site`, `recipe`, `version`, `reason`, `fixProposed` |
| `{ on: email.classified, label: [interview] }` | An `email.classify` step labels an email | `label`, `reason`, `message` (the email) |
| `{ on: flow.later }` | Another pipeline's `flow.later` fires | `data`, `key`, `scheduledAt`, `scheduledByRunId` |
| `{ on: view.action, collection: releases }` | A row's button on a pipeline's page | `collection`, `key`, `item` (the row), `action` |
| `{ on: entity.changed, type: Job, field: salary, stage: interview }` | An entity of the pipeline's App is added or changed, by another pipeline or by you (`field`: only changes of it; `stage`: only a move into it) | `app`, `type`, `key`, `item`, `before` (null when added), `changed` (field names), `by`, `stage` (`from`, `to`, or null) |
| `{ on: entity.action, type: Job }` | An entity's button on its page | `app`, `type`, `key`, `item`, `action` |
| `{ webhook: hmac-sha256 }` or `{ webhook: token }` | An HTTP call from the internet (GitHub-style signature, or a bearer token) | `body`, `event`, `receivedAt` |

Only an email's own addresses (`email.classified`) and a posting's own URL (`application.status`) may be used as
targets of a side effect. Webhook bodies, `flow.later` data, view rows and entities pipelines write are never trusted as targets; an entity of a `mine` type is.

---

## 4. The step catalog

Each step lists what it does, its main inputs (defaults in brackets) and its outputs. Marks:

- ⚡ **side effect**: sends or submits something outside Storm; always behind a gate, never retried.
- 🧠 **LLM**: costs LLM tokens; the monthly budget applies.
- 🖥️ **browser**: needs the self-hosted browser; not available in the multi-user product.

### 4.1 Data

#### `data.dedupe`
Removes items whose `key` repeats, keeping the first. With `againstType: Job` (a type of the pipeline's App, M33) it
also drops the items already kept as entities of it, so each posting comes through once (`against: JobPosting` does
the same with what the old Jobs page kept).
- In: `from` (list), `key`, `againstType` or `against` (optional).
- Out: `items`, `duplicates` (how many were removed).

```yaml
- id: fresh
  type: data.dedupe
  with: { from: "{{search.items}}", key: url, against: JobPosting }
```

#### `data.filter`
Keeps the items that match **every** condition. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`.
Fields can be dotted paths.
- In: `items`, `where` (list of `{ field, op, value }`).
- Out: `items`, `removed`.

```yaml
- id: good
  type: data.filter
  with:
    items: "{{score.scored}}"
    where:
      - { field: score, op: gte, value: 70 }
      - { field: location, op: contains, value: Remote }
```

#### `data.save`
Saves items and says what changed since the last save.
- **Default (job postings)**: saves by `url` to the Jobs page, with a `status` (`NEW`, `SKIPPED`, `SHORTLISTED`).
  A posting saved again keeps its first-seen date, and its status only moves forward.
- **With `collection`**: a named list of your own, one item per `key`. `changed` compares `fields` (default: all).
  `complete: true` means the items are the whole list, so saved items missing from it go to `removed`.
- **With `type`** (a type of the pipeline's App, §2.5): as entities, by the type's key; each field as its kind, your
  (`mine`) fields never written. `fields` and `complete` as with a collection; `key` and `collection` aren't taken.
  `stage` (M33) moves every item to that stage, as the type's moves allow a pipeline (`stage: skipped` for the agencies).
- Out: `saved`, `created`, `skipped`, `added` (new), `changed` (with `before`/`after`), `removed`, `invalid` (with
  `type`: `key`, `saved`, `problems`). In a dry run nothing is saved: `preview` says so first, and the counts are what
  a run would save.

```yaml
# Only new releases continue to the LLM and to you
- id: seen
  type: data.save
  with: { items: "{{feeds.items}}", collection: releases, key: id, fields: [title] }
- id: summary
  type: llm.summarize
  when: "{{seen.added}}"
  with: { content: "{{seen.added}}" }
```

#### `data.read`
Reads entities of a type of the pipeline's App (§2.5) as items, your (`mine`) fields included.
- In: `type`, `where` (as `data.filter`, on the type's fields), `sort` (`"-salary"`, `"@firstSeen"`), `limit` [100],
  `removed` [false: the removed ones instead].
- Out: `items` (typed by the type: `{{item.salary}}` is checked), `count` (matching, before `limit`).

```yaml
# Every Monday: your favourite jobs, the best paid first
- id: favourites
  type: data.read
  with: { type: Job, where: [{ field: favorite, op: eq, value: true }], sort: -salary, limit: 10 }
```

#### `data.history`
Keeps a number per item over time (a price, a count) and adds a `history` object to each item: `previous`, `change`,
`changePct`, `min`, `max`, `count`, `direction` (`new`, `up`, `down`, `same`), `lowest`, `usualChange` (the median
change between the earlier values, once there are 3) and `vsUsual` (this change ÷ the usual one: `3` is three times
the usual growth). The value can be text such as `"1 299,00 €"`.
- In: `items`, `collection`, `key`, `value` (the field with the number), `keep` [60].
- Out: `items`, `recorded`, `unreadable`.

```yaml
- id: prices
  type: data.history
  with: { items: "{{list.items}}", collection: prices, key: url, value: price }
- id: cheaper
  type: data.filter
  with: { items: "{{prices.items}}", where: [{ field: history.direction, op: eq, value: down }] }
```

#### `data.map`
Reshapes JSON into `items` with a [JSONata](https://jsonata.org) expression: for an API whose answer isn't a list of
objects. A list of objects becomes the items, one object a single item, anything else `{ value }`. It reads only its
input (no network, no code) and is stopped after a second; a mistake in the expression shows when you save the
pipeline.
- In: `from` (the JSON, e.g. `{{forecast.json}}`), `expression`, `maxItems` [500].
- Out: `items`, `value` (the expression's result as it is).
- `{{` starts a reference, so write an object inside an object as `{ {` with a space.

```yaml
# Open-Meteo answers with parallel arrays: hourly.time[] and hourly.temperature_2m[]
- id: hours                      # one item per hour
  type: data.map
  with:
    from: "{{forecast.json}}"
    expression: '$map(hourly.time, function($t, $i) { { "time": $t, "temp": hourly.temperature_2m[$i] } })'
- id: next12h                    # or one item: the lowest of them
  type: data.map
  with: { from: "{{forecast.json}}", expression: '{ "place": "Sofia", "min": $min(hourly.temperature_2m) }' }
```

#### `data.alert`
Tells once when a number crosses a line, and once when it is back. Each item's `value` is checked against `below` or
`above`; what is past the line is remembered between runs (per pipeline, step and `key`), so an hourly check sends
one message per cold spell, not one an hour. `clearAt` is where it counts as back (default: the line itself); set it
a little further so a value going back and forth isn't told every time. A dry run remembers nothing.
- In: `items`, `key` (what is measured, e.g. `place`), `value` (the field with the number, dotted paths work),
  `below` or `above`, `clearAt`, `label` (the field naming an item in `text`; default: `key`).
- Out: `crossed` (past the line in this run), `cleared` (back in this run), each with `alert` (`value`, `line`,
  `since`); `active` (how many are past the line now); `text` (a line each, e.g. `Sofia: 9.4, below 10` or
  `Sofia: back to 12.5`); `unreadable`.

```yaml
- id: cold
  type: data.alert
  with: { items: "{{next12h.items}}", key: place, value: min, below: 10, clearAt: 12 }
- id: tell
  type: notify.telegram
  when: "{{cold.text}}"
  with: { text: "{{cold.text}}" }

# Faster than usual: data.history's vsUsual, told over 3 times the usual growth, back under 1.5
- id: fast
  type: data.alert
  with: { items: "{{trend.items}}", key: table, value: history.vsUsual, above: 3, clearAt: 1.5 }
```

### 4.2 The web without a browser

#### `http.fetch`
Reads addresses with a plain GET (no cookies, no browser). RSS/Atom becomes `items` (title, url, published, summary,
id, source). JSON is `json`; a list (or the list at `itemsAt`) also becomes `items`. Anything else is `text`. A page
that hasn't changed since the last read (ETag / Last-Modified) is not downloaded again.
- In: `url` or `urls` (up to 25), `headers`, `query`, `itemsAt`, `maxItems` [100], `maxKb` [1024],
  `timeoutSeconds` [20].
- Out: `items`, `json`, `text`, `documents` (status, title, … per address).
- The host must be in `policy.allowedDomains`. On the step cards, a host that isn't has an **Allow** button, and the
  sites a pipeline may read are listed above its steps.
- **API keys**: put `{{cred:name}}` in `headers` or `query` (never in the url). Add the key on the Credentials page as
  kind *API key*, with the API's host as its allowed host. It is sent only there (a redirect to another host fails the
  step), the read isn't cached, and if the API echoes the key back it shows as `•••`.

```yaml
policy: { allowedDomains: [api.example.com, api.github.com, api.openweathermap.org] }
steps:
  - id: tickets
    type: http.fetch
    with: { url: https://api.example.com/v1/tickets?state=open, itemsAt: data.items }

  # With a key: a Bearer header, or a query parameter
  - id: repos
    type: http.fetch
    with:
      url: https://api.github.com/user/repos?sort=pushed
      headers: { Authorization: "Bearer {{cred:github}}", Accept: application/vnd.github+json }
  - id: weather
    type: http.fetch
    with:
      url: https://api.openweathermap.org/data/2.5/forecast?q=London&units=metric
      query: { appid: "{{cred:openweather}}" }
      itemsAt: list
```

#### `http.request` ⚡
Changes something at an API: one `POST`, `PUT`, `PATCH` or `DELETE`, with `body` sent as JSON. It waits at its gate,
which shows the method, address, headers and body, until you press Act. The address's host must be allowed (a literal
address joins the pipeline's allowed domains, or you approve a new one at the gate); never a private or VPN
address, and a redirect isn't followed. An API key goes in `headers` or `query` as `{{cred:name}}`, as in `http.fetch`.
An answer other than 2xx fails the step with its status.
- In: `method`, `url`, `headers`, `query`, `body`, `timeoutSeconds` [20].
- Out: `status`, `json` (when the answer is JSON), `text`.

```yaml
# A GitHub issue when Release watch fails
trigger: { on: run.finished, pipeline: Release watch, status: [FAILED] }
steps:
  - id: issue
    type: http.request
    with:
      method: POST
      url: https://api.github.com/repos/<owner>/<repo>/issues
      headers: { Authorization: "Bearer {{cred:github}}", Accept: application/vnd.github+json }
      body: { title: "Storm: {{trigger.pipeline}} failed", body: "{{trigger.summary}}", labels: [storm] }
```

#### `db.query`
Reads a PostgreSQL database with one SQL query; the rows become `items` (column names as fields, counts as numbers,
dates as ISO text). `connection` is a database credential: on the Credentials page, kind *database*, and one field,
the connection string (`postgresql://reader:password@host:5432/app`). The form shows what it connects to (database,
host, port, user; never the password), and its host becomes the only one it may connect to: a name, a VPN name,
an IP address or a Docker service such as `postgres`. Another server is another credential. It is read-only whatever the user may do: the query runs
as a subquery (so only `SELECT`, `VALUES` or `WITH … SELECT` fit), as one statement, in a read-only transaction that
is rolled back, and is stopped after `timeoutSeconds`. Still, give it a database user that may only read.
- In: `connection` (`{{cred:name}}`), `sql`, `params` (the values of `$1`, `$2`, …; never paste values into the SQL),
  `maxRows` [500], `timeoutSeconds` [10].
- Out: `items`, `rows`, `truncated` (there were more than `maxRows`), `columns`.

```yaml
# Row counts per table, kept as a trend and told when one grows faster than usual
- id: counts
  type: db.query
  with:
    connection: "{{cred:app-db}}"
    sql: SELECT relname AS name, n_live_tup AS rows FROM pg_stat_user_tables
- id: trend
  type: data.history
  with: { items: "{{counts.items}}", collection: table-rows, key: name, value: rows }

# With a value: orders stuck for more than 30 minutes
- id: stuck
  type: db.query
  with:
    connection: "{{cred:app-db}}"
    sql: SELECT id, placed_at FROM orders WHERE status = $1 AND placed_at < now() - interval '30 minutes'
    params: [PENDING]
```

#### `shop.product` 🧠
The price of a product, or of one variant (`select: { size: M, color: Black }`), read from its page. It uses the
page's schema.org data or price meta tags; if there are none, it opens the page in the headless browser, and as a last
resort the cheap model reads the price from the text.
- In: `url`, `urls` or `products` (each with its own `select`), `browser` [`fallback`, or `always`/`never`], `llm` [true].
- Out: `items` (id, url, title, brand, price, currency, availability, inStock, variant, problem), `problems`, `report`.
- `id` identifies product + variant: use it as the `key` for `data.history`.

```yaml
policy: { allowedDomains: [www.bergfreunde.eu] }
steps:
  - id: products
    type: shop.product
    with:
      products:
        - url: https://www.bergfreunde.eu/fjaellraeven-skogsoe-padded-jacket-casual-jacket/
          select: { size: M, color: Black }
  - id: prices
    type: data.history
    with: { items: "{{products.items}}", collection: product-prices, key: id, value: price }
```

#### `price.watch` 🧠
Checks your watched **Products** in the pipeline's App (M33: save [pipelines/apps/prices.yaml](../pipelines/apps/prices.yaml)
and say `app: Prices`): a `mine` type, each with its `shops`, a line each (`https://shop/p/7 | size: M, color: Black`
for a variant). Each shop's page is read like `shop.product` and kept as an **Offer** with its price history (the
Offer's page charts it; a line you remove takes its Offer off). It reports only news: a shop at or under your target
price (once, when it crosses), the lowest in `lowestDays`, back in stock. `text` names the cheapest shop for each, and
is empty when there is nothing new. The addresses are yours, so they need no `allowedDomains`. *Move them here* on the
App's page brings the products, shops and price history the old Prices page kept.
- In: `product` (only this one; default: all enabled), `lowestDays` [90].
- Out: `products`, `news`, `text`, `problems`, `report`.

```yaml
- id: watch
  type: price.watch
  with: { lowestDays: 90 }
- id: tell
  type: notify.telegram
  when: "{{watch.text}}"
  with: { text: "{{watch.text}}" }
```

### 4.3 LLM

The LLM's output is treated as untrusted text: it can be shown, sent as a body, or saved, but never used as an
address, a recipient or a domain.

#### `llm.classify` 🧠
Labels each item following `instruction`. Items with a `keep` label go to `kept`, the rest to `dropped`.
- In: `items`, `instruction`, `labels` [`keep`, `drop`], `keep` [`keep`].
- Out: `kept`, `dropped`, `results` (index, label, reason).

```yaml
- id: agencies
  type: llm.classify
  with:
    items: "{{fresh.items}}"
    instruction: '"agency": a recruitment agency hiring for an unnamed client. "employer": the company hires for itself.'
    labels: [employer, agency]
    keep: [employer]
```

#### `llm.score` 🧠
Scores each item 0–100 against `against` (a profile or criteria). `top` keeps the best N. With `outcomes: true`, the
outcomes of your past applications (interviews, rejections, silence) calibrate the scores for job postings.
- In: `items`, `against`, `instruction`, `top`, `outcomes` [false].
- Out: `scored` (all, with `score` and `scoreReason`), `top`.

```yaml
- id: score
  type: llm.score
  with:
    items: "{{agencies.kept}}"
    against: Staff/Principal engineer or architect, TypeScript and Node.js, remote or hybrid.
    top: 10
    outcomes: true
```

#### `llm.generate` 🧠
Writes text following `instruction`, using `context`. Text you approve at a gate becomes an example it learns from.
- In: `instruction`, `context`, `format` [`text`, or `markdown`].
- Out: `text`.

```yaml
- id: lines
  type: llm.generate
  when: "{{cheaper.items}}"
  with:
    instruction: "One line per product: title, old price → new price, then its url. No other text."
    context: "{{cheaper.items}}"
```

#### `llm.summarize` 🧠
Summarizes `content`.
- In: `content`, `instruction`, `maxWords` [150].
- Out: `summary`.

```yaml
- id: notes
  type: llm.summarize
  with:
    content: "{{trigger.item}}"
    instruction: Security fixes, breaking changes and required migrations, in that order.
    maxWords: 200
```

#### `llm.extract` 🧠
Reads named fields out of text (an email, a page). `fields` maps each name to what it is (1–20). Dates and times come
as ISO 8601 with an offset.
- In: `content`, `fields`, `instruction`, `timeZone` [Europe/Sofia].
- Out: `values` (each as text, `""` when not found), `missing`, `found` (true when nothing is missing).

```yaml
- id: invite
  type: llm.extract
  forEach: "{{triage.kept}}"
  with:
    content: "{{item}}"
    fields:
      start: when the interview starts, date and time
      company: the company
      place: the address, or the video call link
```

### 4.4 Email

Reading uses IMAP and sending uses SMTP, with the `mail` credential. Reading never marks or moves anything.

#### `email.fetch`
The emails that arrived since this pipeline's last run (the first run looks back `sinceDays`), oldest first, so each
email is read once. Text only: attachments are listed, not downloaded. `mailbox: Sent` reads your server's Sent folder,
whatever it is called there (`[Gmail]/Sent Mail`, a translated name): the emails you wrote.
- In: `mailbox` [INBOX], `limit` [50], `sinceDays` [2].
- Out: `messages` (uid, messageId, threadId, from, fromName, replyTo, to, cc, subject, date, text, attachments, …).

```yaml
- id: fetch
  type: email.fetch
  with: { mailbox: INBOX, limit: 50, sinceDays: 2 }
```

#### `email.classify` 🧠
Like `llm.classify`, for emails. Each labelled email also emits an `email.classified` event, which can start other
pipelines. An email nobody can answer (a no-reply sender such as `messaging-digest-noreply@linkedin.com`, or mail you
sent to yourself, like Storm's own messages) is never kept for a reply: it is labelled skip without asking the LLM. This
is on when `keep` has `reply`; set `answerable` to choose.
- In: `messages`, `instruction`, `labels` [`reply`, `skip`], `keep` [`reply`], `answerable`.
- Out: `kept`, `dropped`, `results`.

```yaml
- id: triage
  type: email.classify
  with:
    messages: "{{fetch.messages}}"
    instruction: '"reply": a recruiter or client writing to me personally. "skip": everything else.'
```

#### `email.draftReply` 🧠
Drafts a reply in your voice, in the email's language, without inventing facts. It reads the thread's earlier
messages from your mailbox (the email's References, up to 10, without their quoted text), so it knows what was said
before. With a topic it also knows what your approved memory of the topic says is true now (only current facts; when there are more than fit, yours first, then those closest to the
email: by meaning with an embeddings provider, else by shared words), and
the gate's "Why" lists the facts the draft used, each with its source. `topic`: `auto` (the default: the email's topics
that aren't waiting for you, else its thread's), `none`, or a topic's name. What neither the memory nor the email says
is still a placeholder. With a topic that has sources, the passages closest to the email go in too, and a passage it
used is cited at the gate (`docs/adr/0012-database.md @ a1b2c3d`). It never decides the recipient. Edits you make at the gate teach it your style.
- In: `message`, `instruction`, `context` (what it may draw on: availability, rates, links), `signature`, `topic`.
- Out: `subject`, `body`, `language`, `drewOn` (the facts it used; empty without a topic).

#### `email.send` ⚡
Sends an email from your mailbox. With `inReplyTo` and `references` it is a reply in the same thread. `to` must come
from real data (e.g. `{{item.from}}`), a literal, or `policy.allowedRecipients`. A reply is never sent to a no-reply
address or to your own address: the step fails with why.
- In: `to`, `subject`, `body`, `inReplyTo`, `references`.
- Out: `messageId`, `accepted`.

```yaml
- id: draft
  type: email.draftReply
  forEach: "{{triage.kept}}"
  with:
    message: "{{item}}"
    instruction: Reply briefly. If it could fit, ask for the rate and propose a short call; if not, decline politely.
- id: send                      # a gate is inserted before it: you see and edit each reply, then press Act
  type: email.send
  forEach: "{{triage.kept}}"
  with:
    to: "{{item.from}}"
    subject: "{{draft.subject}}"
    body: "{{draft.body}}"
    inReplyTo: "{{item.messageId}}"
    references: "{{item.references}}"
limits: { email.send: 20/day }
```

#### `email.awaiting`
Your sent emails that got no answer: threads whose last message is yours, older than `afterDays`, with nothing from the
other side since. Each email is listed once; a thread comes back only when you write in it again.
- In: `afterDays` [5], `lookbackDays` [30], `mailbox` [INBOX], `sentMailbox` (default: the server's Sent folder),
  `maxFollowUps` [1], `limit` [5].
- Out: `threads` (threadId, to, subject, sentAt, daysWaiting, followUps, message, references).

#### `email.draftFollowUp` 🧠
Drafts a short, polite follow-up to your own unanswered email, in its language, without new facts or pressure. It
reads the thread's earlier messages too, and the memory of the thread's topics (`topic`, as for `email.draftReply`).
- In: `message`, `instruction`, `daysWaiting`, `signature`, `topic`.
- Out: `subject`, `body`, `language`, `drewOn`.

```yaml
- id: waiting
  type: email.awaiting
  with: { afterDays: 5 }
- id: draft
  type: email.draftFollowUp
  forEach: "{{waiting.threads}}"
  with: { message: "{{item.message}}", daysWaiting: "{{item.daysWaiting}}" }
- id: send
  type: email.send
  forEach: "{{waiting.threads}}"
  with:
    to: "{{item.to}}"
    subject: "{{draft.subject}}"
    body: "{{draft.body}}"
    inReplyTo: "{{item.message.messageId}}"
    references: "{{item.references}}"
```

#### `topic.match` 🧠
Which of your topics (the Topics page; docs/design.md §8.1) each email belongs to. The directions you gave come first,
without an LLM: a word in the subject or text, anyone at a domain, a person; an email whose thread already belongs to a
topic belongs to it too. The cheap model looks only at emails no direction settles (a thread's later email included, in
case the conversation moved to another subject), with each topic's description and directions. An email can belong to
several topics, and to none, which is normal. Found by a direction or the thread: linked; only by the model: suggested,
waiting for you. Your own decisions stay: a topic you rejected for an email isn't suggested for it again. Use it after
triage, not on all mail. An email no topic took is kept for 30 days (its sender, subject and date, never its text), for
the nightly reflection to suggest a new topic from several of them. A dry run links and keeps nothing.
- In: `messages`, `more` (emails that need no triage, like your own sent ones: `email.fetch` with `mailbox: Sent`),
  `topics` (only these, by name; default: every active topic).
- Out: `results` (per email: messageId, topics with status, how found and the line that shows it), `linked` (the emails
  with a linked or confirmed topic), `unlinked`.

```yaml
- id: topics
  type: topic.match
  with: { messages: "{{triage.kept}}" }
```

#### `topic.extract` 🧠
What emails state that is worth remembering about the topics they belong to: decisions, dates, numbers, owners,
requirements, and changes to them. It reads only emails linked to a topic (topic.match's `linked`; a suggested link
waits for you, and so does memory from it), each without the quoted thread under it. Two passes keep it cheap: the
cheap model first asks whether an email states anything worth remembering (most don't); only those go to the writing
model, which compares them with what the topic knows. Each proposal is new, a change (the old fact will be superseded)
or a conflict (two sources disagree), with its source and the line that shows it. With `documents` (topic.index's `files`) it also
reads the changed files of your topics' sources, a decision record or a spec, the same way; a source's first read is
only indexed. It writes nothing. Something that looks like a secret is never proposed, nor what you said an email or a
file was wrong about; a fact you wrote or confirmed is only ever disputed, never replaced.
- In: `messages`, `topics` (only these, by name; default: every active topic), `matches` (topic.match's `results`:
  the topics it linked count too, also in a dry run, where it stores no link), `documents` (topic.index's changed `files`).
- Out: `proposals` (for gate.review, then topic.apply), `title` ("2 facts for Orion", for the gate).

#### `topic.apply`
Writes the fact proposals you approved at a gate.review of the same run: a new fact, a change (the old one kept in the
history, superseded) or a conflict (both in dispute until you say which holds, on the Topics page). Evidence counts by
the date of its source, not the order it was read in: a change from an email older than the fact it replaces goes into
the history. Each one is a change on the topic's page that you can undo. A proposal no gate of the run approved is not
written; a dry run writes nothing.
- In: `proposals` (the gate's `selected`).
- Out: `applied` (how many), `skipped` (each with why: already known, you said it was wrong, not approved).

#### `git.changes`
The files changed in your topics' GitHub sources (on the Topics page: a repository, a path like `docs/adr/**`, a branch)
since each was last indexed, at its branch's head: text files under its path only (Markdown, AsciiDoc, plain text). The
first read lists every one. Seeing that nothing changed is one call to GitHub, no LLM. A private repository needs a
read-only token, kept as a credential allowed for `api.github.com` only. It only reads: `topic.index` moves each source on
once its files are indexed, so a failed index is read again next time.
- In: `topics` (only these, by name; default: every active topic).
- Out: `changes` (topic, repo, path, added / modified / removed, commit, its date, link), `sources` (each source read,
  from which commit to which), `problems`.

#### `drive.changes`
The files changed in your topics' Google Drive sources (on the Topics page: a folder by its link, and optionally a path
like `Specs/**`) since each was last indexed: Google Docs (exported as Markdown), Slides, PDFs and text files, in the
folder or its subfolders. It reads through your Google connection, which must allow Drive (read-only; Settings shows
it, [google-setup.md](google-setup.md)). Seeing that nothing changed is one call to Drive's changes list, no LLM, however
many folders; the first read lists the folder. A file deleted, binned or moved out of the folder is `removed`; a
renamed one is `modified` under its new path. It only reads: `topic.index` moves each source on.
- In: `topics` (only these, by name; default: every active topic).
- Out: `changes` (topic, folder, path, added / modified / removed, the file's version and date, link, its Drive id and
  type), `sources` (each source read), `problems` (Google not connected, Drive not allowed, a folder not found).

#### `topic.attachments`
The readable attachments (PDFs, text files) of emails linked to a topic become its sources, by reference: the email, its
mailbox and UID, and the file's name, never a copy. Their passages are indexed like a repository's files, for drafts to
quote ("api-spec.md, attached to Maria: The API spec"). An attachment never changes: it is read once, and again only
after a rebuild on the Topics page. Give it the inbox's triaged emails with `mailbox` where they were read: a UID means
something only in its own folder. A dry run reads and writes nothing.
- In: `messages`, `mailbox` [INBOX], `matches` (topic.match's `results`).
- Out: `added` (new sources), `passages`, `problems`.

#### `topic.index`
Indexes git.changes' and drive.changes' files into their topics' passages: each file split at its headings, with its
path and commit (a Drive file: its version) and, with OpenAI embeddings set up, a vector; a removed file's passages go.
Then each source is marked read where it was read to. The passages are a cache, never a copy you keep up to date: the
topic's page rebuilds them, and deleting them loses nothing. Drafts get the passages closest to the email (by
embedding, else by its words), each cited with its file and commit (a Drive file: its folder). A dry run reads the
files and writes nothing.
- In: `changes`, `sources`: one step's lists, or both steps' as a list of two (below).
- Out: `files` (the changed files with their text, for topic.extract), `passages`, `removed`, `problems`.

```yaml
- id: repos
  type: git.changes
  with: {}
- id: drive
  type: drive.changes
  with: {}
- id: indexed
  type: topic.index
  with:
    changes: ["{{repos.changes}}", "{{drive.changes}}"]
    sources: ["{{repos.sources}}", "{{drive.sources}}"]
- id: facts
  type: topic.extract
  with: { messages: "{{topics.linked}}", matches: "{{topics.results}}", documents: "{{indexed.files}}" }
- id: review
  type: gate.review
  when: "{{facts.proposals}}"
  with: { items: "{{facts.proposals}}", title: "{{facts.title}}" }
- id: remember
  type: topic.apply
  when: "{{facts.proposals}}"
  with: { proposals: "{{review.selected}}" }
```

### 4.5 Job applications

#### `application.outcome` 🧠
Reads what an email says about one of your submitted applications, matches it to the application (by the sender's
domain or the company's name, and the role) and moves it on: `RESPONDED`, `INTERVIEW` or `REJECTED`. Only forward.
It emits `application.status`, which can cancel a scheduled follow-up. An automatic "we received it" isn't an answer.
In the Job Search App (M33, `app: Job Search`) it works on the Jobs you applied to, moving each as its stages allow a
pipeline, the email noted in its comments; `browser.mapForm` and `browser.fillAndSubmit` move a Job to prepared and
applied, and `llm.score` calibrates on the Jobs' outcomes, all still emitting `application.status`.
- In: `message`.
- Out: `matched`, `applicationId`, `job`, `status`, `changed`, `reason`.

```yaml
- id: outcome
  type: application.outcome
  forEach: "{{triage.kept}}"
  with: { message: "{{item}}" }
- id: tell
  type: notify.telegram
  forEach: "{{triage.kept}}"
  when: "{{outcome.changed}}"
  with: { text: "{{outcome.job.company}}: {{outcome.status}}. {{outcome.reason}}" }
```

### 4.6 Bills

#### `bill.read` 🧠
Reads bills out of emails: the email text and its PDF attachments go to the LLM, which decides whether it's a bill and
reads issuer, amount, currency, due date, period and reference. Emails that aren't bills are dropped. Nothing is paid.
- In: `messages`, `mailbox` [INBOX].
- Out: `bills`, `notBills`.

#### `bill.save`
Keeps bills as **Bill entities of the pipeline's App** (M33: save [pipelines/apps/bills.yaml](../pipelines/apps/bills.yaml)
and say `app: Bills`; the compiler checks the App has a Bill type it can write). The same bill again updates it and
keeps whether you paid it; a new one is `due`. It returns what to do next: `remind` (new
bills with a due date, each with `remindAt`, `remindDaysBefore` days before at 09:00) and `jumps` (new bills more than
`jumpPercent` above the issuer's usual amount), with `jumpText` describing them. The Bills App's list shows them by month
with the total and what is unpaid, a badge on what is due soon, and Mark paid on each row; the morning brief tells you
the unpaid ones due within three days. *Move them here* on the App's page brings the bills the old Bills page kept.
- In: `bills`, `remindDaysBefore` [3], `jumpPercent` [30].
- Out: `added`, `updated`, `remind`, `jumps`, `jumpText`.

```yaml
- id: read
  type: bill.read
  when: "{{triage.kept}}"
  with: { messages: "{{triage.kept}}" }
- id: save
  type: bill.save
  with: { bills: "{{read.bills}}" }
- id: remind
  type: calendar.create
  forEach: "{{save.remind}}"
  with: { title: "{{item.title}}", start: "{{item.remindAt}}", durationMinutes: 15 }
- id: jump
  type: notify.telegram
  when: "{{save.jumpText}}"
  with: { text: "{{save.jumpText}}" }
```

### 4.7 Google Calendar

Needs Google Calendar connected in Settings (see [google-setup.md](google-setup.md)).

#### `calendar.find`
Your events between `from` and `to` (default: the next 7 days), optionally matching `query`. `durationMinutes` gives a
window from `from`, to see what an event at that time would clash with.
- In: `from`, `to`, `durationMinutes`, `query`, `timeZone`, `maxResults` [50].
- Out: `events` (id, title, start, end, allDay, location, link, meetLink, attendees, organizer), `count`, `none`.

#### `calendar.create` ⚡
Creates an event. With `attendees`, Google emails them an invitation from your account. An event with the same title at
the same start isn't created twice.
- In: `title`, `start`, `end` or `durationMinutes` [60], `timeZone`, `description`, `location`, `attendees`, `meet`
  [false], `sendInvites` [true].
- Out: `created`, `eventId`, `link`, `meetLink`, `invited`.

```yaml
- id: around
  type: calendar.find
  forEach: "{{triage.kept}}"
  when: "{{invite.values.start}}"
  with: { from: "{{invite.values.start}}", durationMinutes: 60 }
- id: event
  type: calendar.create
  forEach: "{{triage.kept}}"
  when: "{{invite.values.start}}"
  with:
    title: "Interview: {{invite.values.company}}"
    start: "{{invite.values.start}}"
    location: "{{invite.values.place}}"
    meet: true
```

### 4.8 Browser 🖥️

The browser runs on the self-hosted server. With `headed: true` it's the watchable browser: you can see it in the
run's **live view** and take over when it meets a CAPTCHA, a 2FA prompt or a page it doesn't recognize. Only one
headed run happens at a time.

#### `browser.open` 🖥️
Opens a page and returns its text. It can sign in first with a stored credential, and stays signed in between runs.
It submits nothing but the sign-in.
- In: `url`, `headed` [false], `login` (`credential: "{{cred:name}}"`, optional `username`/`password`/`submit`
  selectors), `waitFor` (a selector; if it doesn't appear, you take over), `timeoutSeconds` [30].
- Out: `url`, `title`, `text`, `signedIn`.

```yaml
- id: account
  type: browser.open
  with:
    url: https://jobs.example.com/my/applications
    headed: true
    login: { credential: "{{cred:jobs-example}}" }
    waitFor: .applications-list
- id: summary
  type: llm.summarize
  with: { content: "{{account.text}}", instruction: Which applications changed status? }
```

#### `browser.extract` 🖥️
Reads a list (e.g. job postings) from a site with a saved **recipe** (Recipes page): headless, no LLM, every page up to
the recipe's limit. A list value in `params` runs one search per value. When the site changes and the recipe no longer
matches, the step fails clearly and marks the recipe broken (event `recipe.broken`). With `fallback: true`,
`browser.agent` finds the list instead, a fixed recipe is proposed for you to approve, and the run continues with it.
- In: `recipes` (1–5), `params`, `maxItems` [200], `fallback` [false], `timeoutSeconds` [30].
- Out: `items` (the recipe's fields plus `source`), `pages`.

```yaml
- id: search
  type: browser.extract
  with:
    recipes: [jobs.example.com/search]
    params: { category: [javascript, python, back-end-development] }
    maxItems: 500
    fallback: true
```

A recipe ([recipes/example-jobs.yaml](../recipes/example-jobs.yaml)) names the list's address, its params, the item
selector, each field's selector, the key, how to reach the next page, and a polite delay between pages.

#### `browser.teach` 🖥️ 🧠
Teach mode, used once per site: opens `url` in the live browser, you bring it to the list and press Continue, the LLM
proposes a recipe, it's checked on the page (items outlined), and Continue saves it as the next version of `recipe`.
- In: `recipe`, `url`, `params` (values in the address that become params), `fields` [url, title, company, location,
  posted], `hint`.
- Out: `recipe`, `version`, `url`, `items`.

```yaml
- id: teach
  type: browser.teach
  with:
    recipe: shop.example/hdd
    url: https://shop.example/hdd?capacity=8tb
    fields: [url, title, price]
    hint: The product cards, not the "recommended" strip.
```

#### `browser.mapForm` 🖥️ 🧠
Opens an application form (following the page's Apply button if needed) and reads every field, typing nothing. It
proposes each value from your profile (Settings), writes free-text answers following `message`, uses your stored facts and
asks you what it can't answer, and attaches the stored document `cv` to the CV field. Its output is the payload of
`browser.fillAndSubmit`, which you see and can edit at the gate.
- In: `url`, `headed`, `cv`, `message`, `job`, `timeoutSeconds`.
- Out: `formUrl`, `fields` (key, label, type, required, options, value, source), `files`, `submit`, `notes`.

#### `browser.fillAndSubmit` ⚡ 🖥️
Fills the form with exactly the approved fields and files, and submits it in the live browser. Before typing, it reads
the form again: a changed field, a new required field or another address pauses the run, and nothing is sent. With
`stopBeforeSubmit: true` it fills everything and you press the final button yourself. With `job`, that posting's
application is marked submitted (event `application.status`).
- In: `url`, `fields`, `files`, `stopBeforeSubmit` [false], `job`, `timeoutSeconds`.
- Out: `submitted`, `url`, `confirmation`.

```yaml
- id: map
  type: browser.mapForm
  forEach: "{{shortlist.selected}}"
  with:
    url: "{{item.url}}"
    cv: cv-main
    job: "{{item}}"
    message: Why this role fits me, from my profile only, 2-3 sentences.
- id: apply
  type: browser.fillAndSubmit
  forEach: "{{shortlist.selected}}"
  with:
    url: "{{map.formUrl}}"
    fields: "{{map.fields}}"
    files: "{{map.files}}"
    job: "{{item.url}}"
    stopBeforeSubmit: true
limits: { browser.fillAndSubmit: 5/day }
```

#### `browser.agent` 🖥️ 🧠
For a site without a recipe: an LLM works the page towards `goal` (find the apply button and fill the form, read
something), from the page's accessibility outline. It can navigate, click, type, select, tick, attach one of
`documents` and read, at most `maxActions` times, only on the start site and the allowed domains. **It sends
nothing**: no submit is pressed, no file is picked. Its recorded actions are the payload of `browser.submit`.
- In: `url`, `goal`, `headed`, `documents`, `message`, `job`, `maxActions` [25], `timeoutSeconds`.
- Out: `outcome` (`ready`: a form is filled and its final button found; `done`: nothing to send), `answer`,
  `actions`, `files`, `submit`, `url`, `pageUrl`, `notes`.

#### `browser.submit` ⚡ 🖥️
Repeats an approved `browser.agent` run exactly, without the LLM, and presses its final button. An element that's
gone, or a page off the allowed sites, pauses the run with nothing sent.
- In: `url`, `actions`, `files`, `submit`, `stopBeforeSubmit` [false], `job`, `timeoutSeconds`.
- Out: `submitted`, `url`, `confirmation`.

```yaml
- id: agent
  type: browser.agent
  with:
    url: "{{trigger.job.url}}"
    goal: Find the application form and fill it from my profile; attach my CV.
    documents: [cv-main]
    headed: true
- id: send                    # gate inserted: you see every recorded action and the final button first
  type: browser.submit
  with:
    url: "{{agent.url}}"
    actions: "{{agent.actions}}"
    files: "{{agent.files}}"
    submit: "{{agent.submit}}"
```

#### `browser.download` 🖥️
Downloads a file: the address itself, or what clicking `click` on that page downloads. It lands in quarantine and is
kept only when its size and its real content type (not its name) are allowed: PDF, images, Office documents, text.
- In: `url`, `click`, `headed`, `timeoutSeconds`.
- Out: `artifactId`, `filename`, `mime`, `size`, `sha256`.

#### `browser.upload` ⚡ 🖥️
Puts one of your stored documents (from `file.read`) into a file field and presses `submit` if given. Many sites upload
as soon as a file is chosen, so this is always behind a gate.
- In: `url`, `field` (selector of the file input), `file`, `submit`, `timeoutSeconds`.
- Out: `uploaded`, `url`, `confirmation`.

### 4.9 Documents

#### `file.read`
Reads the text of a stored document (Documents page, e.g. `cv-main`) or of a file `browser.download` kept. Text files
as they are, PDFs' text. Its output also binds the document by content, so `browser.upload` sends exactly the version
you approved.
- In: `document` or `artifact`, `maxChars` [20000].
- Out: `filename`, `mime`, `sha256`, `text`, `truncated`, `document`, `documentId`, `artifactId`.

```yaml
# Download a statement, summarize it
- id: statement
  type: browser.download
  with: { url: https://bank.example/statements, click: "a.latest-pdf", headed: true }
- id: text
  type: file.read
  with: { artifact: "{{statement.artifactId}}" }
- id: summary
  type: llm.summarize
  with: { content: "{{text.text}}", instruction: Totals by category, and anything unusual. }

# Upload your CV to a site (gate inserted before upload)
- id: cv
  type: file.read
  with: { document: cv-main }
- id: upload
  type: browser.upload
  with: { url: https://ats.example.com/profile, field: "#resume", file: "{{cv}}" }
```

### 4.10 You in the loop

#### `gate.review`
Pauses the run and shows a list; you pick which items go on.
- In: `items`, `title`.
- Out: `selected`.

```yaml
- id: shortlist
  type: gate.review
  with: { items: "{{score.top}}", title: "Today's best jobs" }
```

#### `gate.act`
Shows the exact payload of the side-effect step named in `for`; that step runs only after you press **Act** (or Approve
on Telegram). You rarely write it: the compiler inserts one before every side-effect step. Write it yourself only to
place it differently; it must come before its step, after every step that step uses, and loop over the same items.
- In: `for` (the step id).
- Out: `approved`.

```yaml
- id: sendGate
  type: gate.act
  forEach: "{{triage.kept}}"
  with: { for: send }
- id: send
  type: email.send
  forEach: "{{triage.kept}}"
  with: { to: "{{item.from}}", subject: "{{draft.subject}}", body: "{{draft.body}}" }
```

### 4.11 Telling you

#### `notify.telegram`
Sends you a Telegram message (only to you, never to anyone else). See [telegram.md](telegram.md).
- In: `text` (up to 4000 characters).
- Out: `sent`.

#### `notify.digest`
Sends you a Telegram digest of the last `hours`: what ran, what waits for you, what failed.
- In: `hours` [24].
- Out: `sent`, `text`.

```yaml
name: Daily digest
trigger: { schedule: "0 19 * * *", tz: Europe/Sofia }
steps:
  - id: digest
    type: notify.digest
    with: { hours: 24 }
```

### 4.12 Timing

#### `flow.later`
Starts another pipeline (whose trigger is `{ on: flow.later }`) `after` a while (`30m`, `36h`, `7d`) or `at` a time,
with `data` as its `{{trigger.data}}`. It fires once, unless cancelled first by `flow.cancel` with its `key`, or by an
event matching `cancelOn`. Another `flow.later` with the same key replaces it.
- In: `pipeline`, `after` or `at`, `timeZone`, `data`, `key`, `cancelOn` (`{ event, match }`).
- Out: `scheduledStartId`, `fireAt`, `replaced`.

#### `flow.cancel`
Cancels the starts `flow.later` scheduled with `key` that haven't started yet.
- In: `key`.
- Out: `cancelled`.

```yaml
# 7 days after you apply, a reminder, unless the employer answers first
name: Follow-up after applying
trigger: { on: application.status, status: [SUBMITTED] }
steps:
  - id: later
    type: flow.later
    with:
      pipeline: Follow-up reminder
      after: 7d
      key: "follow-up:{{trigger.applicationId}}"
      data: { job: "{{trigger.job}}" }
      cancelOn:
        event: application.status
        match: { applicationId: "{{trigger.applicationId}}" }
```

```yaml
# Cancel it by hand, e.g. when you withdraw
- id: stop
  type: flow.cancel
  with: { key: "follow-up:{{trigger.applicationId}}" }
```

---

## 5. Putting it together

What the steps add up to, with the pipeline that does it:

| Goal | Steps | Example |
| --- | --- | --- |
| Draft replies to recruiters and clients, send after you approve | `email.fetch` → `email.classify` → `topic.match` (the email of your topics is left to Topic replies) → `email.draftReply` → `email.send` | [recruiter-replies.yaml](../pipelines/recruiter-replies.yaml) |
| Draft replies to the email of your topics with what Storm knows about them, send after you approve | `email.fetch` → `email.classify` → `topic.match` → `email.draftReply` (`topic: auto`, on `linked`) → `email.send` | [topic-replies.yaml](../pipelines/topic-replies.yaml) |
| Find new jobs, score them, let you pick, fill the forms | `browser.extract` → `data.dedupe` → `llm.classify` → `llm.score` → `data.save` → `gate.review` → `browser.mapForm` → `browser.fillAndSubmit` | the Job Search App ([job-search.yaml](../pipelines/apps/job-search.yaml)) with a job-board recipe ([example-jobs.yaml](../recipes/example-jobs.yaml)) and [job-board.yaml](../pipelines/job-board.yaml) up to `data.save` |
| Track answers to your applications | `email.fetch` → `email.classify` → `application.outcome` → `notify.telegram` | [application-replies.yaml](../pipelines/application-replies.yaml) |
| A reminder to follow up a week after applying | `flow.later` (+ a `{ on: flow.later }` pipeline with `llm.generate`) | [follow-up-later.yaml](../pipelines/follow-up-later.yaml), [follow-up.yaml](../pipelines/follow-up.yaml) |
| Keep what is true about your topics (a project, a customer) from your email, with your approval, for your drafts to use | `email.fetch` (INBOX, and Sent: what you wrote) → `email.classify` → `topic.match` → `topic.attachments`; `git.changes`, `drive.changes` → `topic.index`; → `topic.extract` → `gate.review` → `topic.apply` (drafts: `email.draftReply` with `topic: auto`) | [topic-upkeep.yaml](../pipelines/topic-upkeep.yaml) |
| Nudge people who didn't answer your emails | `email.awaiting` → `email.draftFollowUp` → `email.send` | [email-follow-ups.yaml](../pipelines/email-follow-ups.yaml) |
| Turn interview invitations into calendar events with prep notes | `email.fetch` → `email.classify` → `llm.extract` → `calendar.find` → `llm.generate` → `calendar.create` | [interview-invite.yaml](../pipelines/interview-invite.yaml) |
| Keep your bills, with a reminder before they're due | `email.fetch` → `email.classify` → `bill.read` → `bill.save` → `calendar.create` / `notify.telegram` | [bills.yaml](../pipelines/bills.yaml) |
| Keep your trips' bookings from email, with a reminder the day before each, a weather briefing three days before a trip and a packing list on a button | `email.fetch` → `email.classify` → `llm.extract` → `data.map` → `data.save` → `calendar.create`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel`; `http.fetch` (Open-Meteo) → `data.read` → `llm.generate` → `notify.telegram` | the Trips App ([trips.yaml](../pipelines/apps/trips.yaml)) with [trip-bookings.yaml](../pipelines/trip-bookings.yaml), [trip-booking-reminders.yaml](../pipelines/trip-booking-reminders.yaml), [trip-countdown.yaml](../pipelines/trip-countdown.yaml), [trip-briefing.yaml](../pipelines/trip-briefing.yaml), [packing-list.yaml](../pipelines/packing-list.yaml) |
| Freelance work: inquiries become scored leads, a proposal and a payment reminder to a client you added, an invoice draft for a won lead, watched until paid | `email.fetch` → `email.classify` → `data.read` → `llm.extract` → `data.map` → `data.save`; `entity.action` → `data.read` (a `mine` type: its address may be a target) → `llm.generate` → `email.send` → `data.save { stage }`; `entity.changed { stage: won }` → `data.map` → `data.save`; `data.read` → `data.map` → `data.save { stage: overdue }` | the Clients App ([clients.yaml](../pipelines/apps/clients.yaml)) with [client-inquiries.yaml](../pipelines/client-inquiries.yaml), [proposal.yaml](../pipelines/proposal.yaml), [lead-won.yaml](../pipelines/lead-won.yaml), [overdue-invoices.yaml](../pipelines/overdue-invoices.yaml), [payment-reminder.yaml](../pipelines/payment-reminder.yaml) |
| Find a place to rent: new listings marked against what you look for, price drops on your favorites, a request for a viewing to an agent you added, the viewing in your calendar | `browser.extract` → `data.history` → `data.dedupe { againstType }` → `llm.classify` → `data.map` → `data.save`; `entity.action` → `data.read` (a `mine` type) → `llm.generate` → `email.send` → `data.save { stage }`; `entity.changed { field }` → `calendar.create` | the Apartments App ([apartments.yaml](../pipelines/apps/apartments.yaml)) with a listing site's recipe ([example-listings.yaml](../recipes/example-listings.yaml)), [listings.yaml](../pipelines/listings.yaml), [ask-for-viewing.yaml](../pipelines/ask-for-viewing.yaml), [viewing.yaml](../pipelines/viewing.yaml), [compare-favorites.yaml](../pipelines/compare-favorites.yaml) |
| Keep your online orders from the shops' emails, each email merged into its order, with a reminder before the return window closes | `email.fetch` → `email.classify` → `data.read` → `llm.extract` → `data.map` (merged into the saved entity: `data.save` writes it whole) → `data.save`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel` | the Orders App ([orders.yaml](../pipelines/apps/orders.yaml)) with [orders.yaml](../pipelines/orders.yaml), [return-window.yaml](../pipelines/return-window.yaml), [return-reminder.yaml](../pipelines/return-reminder.yaml), [return-request.yaml](../pipelines/return-request.yaml) |
| Keep what you pay for every month or year, with its price history, a reminder before a trial ends or a yearly renewal, and a monthly review | `email.fetch` → `email.classify` → `data.read` → `llm.extract` → `data.map` (merged, a month's price) → `data.history` → `data.filter` → `data.save`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel`; `data.read` → `data.map` (totals per currency) → `llm.generate` | the Subscriptions App ([subscriptions.yaml](../pipelines/apps/subscriptions.yaml)) with [subscriptions.yaml](../pipelines/subscriptions.yaml), [renewal-watch.yaml](../pipelines/renewal-watch.yaml), [renewal-reminder.yaml](../pipelines/renewal-reminder.yaml), [subscription-review.yaml](../pipelines/subscription-review.yaml), [cancel-subscription.yaml](../pipelines/cancel-subscription.yaml) |
| Your car's papers and services: told a month and a week before one runs out (or 1 000 km before a service) and when it's renewed, each date in your calendar | `data.read` (two `mine` types) → `data.map` (days and km left) → `data.alert` → `notify.telegram`; `entity.changed { field }` → `data.map` → `calendar.create` | the Car App ([car.yaml](../pipelines/apps/car.yaml)) with [car-papers-due.yaml](../pipelines/car-papers-due.yaml), [paper-in-calendar.yaml](../pipelines/paper-in-calendar.yaml) |
| Incidents on what you run, each resolved when its cause is gone: a monitor down, a database check above 0, the database out of reach; a GitHub issue after you approve it, and the week in numbers | `{ webhook: token }` → `data.read` → `data.map` → `data.save`; `db.query` → `data.alert` → `data.map` → `data.save`; `run.finished { status: [FAILED] }` → `data.save`; `entity.action` → `http.request` → `data.save { stage }` | the Server ops App ([server-ops.yaml](../pipelines/apps/server-ops.yaml)) with [monitor-alerts.yaml](../pipelines/monitor-alerts.yaml), [database-check.yaml](../pipelines/database-check.yaml), [database-down.yaml](../pipelines/database-down.yaml), [incident-issue.yaml](../pipelines/incident-issue.yaml), [ops-week.yaml](../pipelines/ops-week.yaml) |
| Tell you when a watched product is worth buying | `price.watch` → `notify.telegram` | [prices.yaml](../pipelines/prices.yaml) |
| Prices of a shop's list, or of specific products | `browser.extract` or `shop.product` → `data.history` → `data.filter` → `llm.generate` → `notify.telegram` | [price-watch.yaml](../pipelines/price-watch.yaml), [product-watch.yaml](../pipelines/product-watch.yaml) |
| New releases of your stack, with a page and buttons | `http.fetch` → `data.save` → `llm.summarize` → `notify.telegram`, plus `view` | [release-watch.yaml](../pipelines/release-watch.yaml), [release-notes.yaml](../pipelines/release-notes.yaml) |
| Email you when it will be colder than 10° in the next 12 hours, and when it's back | `http.fetch` → `data.map` → `data.alert` → `email.send` | [cold-weather.yaml](../pipelines/cold-weather.yaml) |
| Open a GitHub issue when a pipeline fails, after you approve it | `http.request` on a `run.finished` trigger | [failed-run-issue.yaml](../pipelines/failed-run-issue.yaml) |
| Tell you when a table grows much faster than usual | `db.query` → `data.history` → `data.alert` → `notify.telegram` | [table-growth.yaml](../pipelines/table-growth.yaml) |
| An evening summary of everything | `notify.digest` | [daily-digest.yaml](../pipelines/daily-digest.yaml) |
| Check the live browser handover | `browser.open` (headed) | [live-view-check.yaml](../pipelines/live-view-check.yaml) |

### What it can't do

- Anything that isn't a catalog step. The builder can only combine these steps; it can't write code. It reads any
  API with `http.fetch` and changes things with `http.request` (with a key from a credential), always after you
  approve.
- Send, submit, upload or create events without your approval.
- Message anyone on Telegram but you.
- Read hosts that aren't allowed, or private network addresses.
- Pay bills, move or delete emails, or mark them read.
- Reach a server on your private network or VPN (Home Assistant, a NAS) with `http.fetch` or `http.request`. A
  database there is reachable with `db.query`, because its credential names the host.
- Write to a database: `db.query` only reads.
- Send an `http.request` without your approval, or follow its redirects.
