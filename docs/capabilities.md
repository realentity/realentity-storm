# Capabilities: what Storm can do, and every step type

Storm runs **pipelines**: short lists of steps, written in YAML (by hand, or by the pipeline builder from a chat
message), that read things, think about them with the LLM, and act only after you approve. A pipeline can do only what
its steps can do, and it can use only steps from the **step catalog** below. The LLM never invents new capabilities;
a new capability is a new step written in code ([packages/steps/src/catalog.ts](../packages/steps/src/catalog.ts)
is the source of truth, the implementations are in [apps/worker/src/steps/](../apps/worker/src/steps/)).

Ready-made pipelines to copy are in [examples/](../examples/). This document explains the building blocks.

---

## 1. At a glance

| Area | What it can do | Steps |
| --- | --- | --- |
| Lists of data | Deduplicate, filter, save and compare with last time, read back an App's entities, track a number over time, reshape an API's JSON, tell once when a number crosses a line | `data.dedupe`, `data.filter`, `data.save`, `data.read`, `data.history`, `data.map`, `data.alert` |
| Databases | Read your own PostgreSQL database with one query, read-only | `db.query` |
| The web without a browser | Read RSS/Atom feeds, JSON APIs (with a key) and pages; change something at an API after you approve; read product prices | `http.fetch`, `http.request`, `shop.product`, `price.watch` |
| Uptime | Check whether a web address, a port or a host answers, how fast, and when its certificate expires; on your network too | `http.check`, `net.check` |
| LLM | Label, score, write, summarize, pull fields out of text | `llm.classify`, `llm.score`, `llm.generate`, `llm.summarize`, `llm.extract` |
| Email | Read new mail, triage it, draft replies, find unanswered emails, draft follow-ups, send | `email.fetch`, `email.classify`, `email.draftReply`, `email.awaiting`, `email.draftFollowUp`, `email.send` |
| Topics | Sort email into the subjects you keep a memory of (a project, a customer), and keep what is true about each, with your approval; read their documents where they live (GitHub, Google Drive) for drafts to quote | `topic.match`, `topic.extract`, `topic.apply`, `topic.tidy`, `git.changes`, `drive.changes`, `topic.index`, `topic.attachments` |
| Job hunting | Track what employers answered to your applications | `application.outcome` |
| Bills | Read bills from emails and their PDFs, keep them, flag unusual amounts | `bill.read`, `bill.save` |
| Google Calendar | Find events, create events (with invites and Meet links) | `calendar.find`, `calendar.create` |
| Browser | Open pages (with sign-in), read lists with recipes and each item's own page, teach recipes, read and fill forms, let an agent work a page, download and upload files | `browser.open`, `browser.extract`, `browser.details`, `browser.teach`, `browser.mapForm`, `browser.fillAndSubmit`, `browser.agent`, `browser.submit`, `browser.download`, `browser.upload` |
| Documents | Read a stored document, a downloaded file or an App's file; keep an email's attachments in an App | `file.read`, `file.keep` |
| You in the loop | Pick items from a list, approve an action, or a list's actions at once (a pipeline you start yourself can act without asking, when you switch that on) | `gate.review`, `gate.act` |
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
    with: { text: "New releases: {{feeds.items}}" }
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
| `{{cred:github}}` | The credential filling the pipeline's (or its App's) slot `github` (§2.6); only where a step takes credentials |
| `{{setting.repository}}` | The text filling its slot `repository` (§2.6), e.g. part of an address |

A value that is **exactly** one reference passes the value as it is (a list stays a list). A reference inside text
(`"Hello {{item.fromName}}"`) is turned into text. The compiler checks every reference and its type before the
pipeline can be saved.

**Transforms (M52)** change a reference's value, after a `|`, in order:

| Transform | Gives |
| --- | --- |
| `{{item.name \| base64}}` | The text as base64 (UTF-8): basic auth, an API that wants a value encoded |
| `{{item.value \| sealedBox: key.json.key}}` | The text sealed to the base64 public key the reference after `:` gives (libsodium's `crypto_box_seal`, as base64): only that key's owner opens it, as GitHub wants a secret |

A plain value is transformed as the step's inputs are read. An App's encrypted field stays sealed: it is opened and
transformed only as `http.request` sends it, after its gate. A credential (`{{cred:…}}`) takes no transform.

### 2.2 `forEach`, `when`, `retries`, `onError`

- **`forEach: "{{triage.kept}}"`** runs the step once per item. Several steps that loop over the same list stay
  aligned: inside the loop, `{{draft.body}}` is the draft for *this* item.
- **`when: "{{save.added}}"`** runs the step only when the value is not empty (a non-empty list or text, `true`, a
  number other than 0, an object). A skipped step also skips the later steps that use its output. Inside `forEach`,
  `when` is checked per item.
- **`retries: 2`** retries a failed step up to 5 times. Side-effect steps are never retried.
- **`onError: continue`** (M54, with `forEach`): an item that fails (after its retries) is recorded and the other items
  still run; that item's later steps over the same list are skipped. The run ends done, its summary saying which
  failed ("2 items failed: put #3, put #7"). Without it, the first failure fails the run. On the step's card: *If an
  item fails, go on with the others*.

### 2.3 Safety rules the compiler enforces

- **Every side effect waits for you.** `http.request`, `email.send`, `calendar.create`, `browser.fillAndSubmit`,
  `browser.upload` and `browser.submit` always get a `gate.act` before them. If you don't write one, the compiler inserts it. The run pauses
  and shows the exact payload (recipient, subject, body, form fields). Nothing goes out until you press **Act**, in the
  app or on Telegram.
- **Unless you start it yourself (M54).** On a pipeline's page, *Act without asking when I start it* (it asks first)
  makes starting it the approval: a run you start (**Run**, an App's button, `/run` on Telegram) approves its gates
  itself, each recorded as approved by starting the run. Only targets written in the pipeline: one taken from data
  (an email's sender, a step's output) still waits. A schedule, an event or a webhook still waits. A dry run never acts.
  It is for the version you turned it on for: the next version is off again until you turn it on. The builder can't
  turn it on (it isn't in the YAML).
- **Targets never come from LLM text.** The recipient of an email, the guests of an event and the address of a form
  must come from real data: the sender of a fetched email, a posting's own URL, a literal in the pipeline, or
  `policy`. `to: "{{draft.body}}"` is rejected.
- **Domains are allowlisted.** `http.fetch`, `shop.product` and the browser steps only go to hosts the pipeline names
  in `policy.allowedDomains` (or a host literally written in the step). Private and VPN addresses are never read.
- **Checks reach only addresses you chose (M47).** `http.check`'s and `net.check`'s address is written in the pipeline
  or is exactly a field of mine of an App entity (a Monitor's address you typed); never from emails, pages, webhooks or
  other steps. Only the latter may be a private, LAN or Tailscale address; loopback, link-local and a cloud's metadata
  service never. A check says only whether it answers: it never reads the page.
- **Credentials only go where a step takes them.** `{{cred:…}}` is accepted only by `browser.open` (for its `login`),
  `http.fetch`'s and `http.request`'s `headers` and `query`, and `db.query`'s `connection`, and opened only on the
  hosts the credential allows. LLM steps never see one, nor its name (§2.6).
- **Budget.** Steps that call the LLM stop once the monthly LLM budget is spent, unless the pipeline is marked
  *essential*.
- **One headed browser.** Runs that use the watchable (headed) browser run one at a time.
- **Dry run.** Every pipeline can be dry-run first: it reads for real, but sends, saves and schedules nothing.
  On the editor's cards, *Try up to here* dry-runs it up to one step: the steps after it don't run, the step shows what
  it gave, and the cards after it pick from that.

### 2.4 A page for the pipeline (`view`)

> M33: an App's pages (§2.5) do all of this and more; Release watch and Table growth are now in the Releases and
> Tables Apps ([examples/apps/](../examples/apps/)). `view` still works, until it goes with the old pages.

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
  `datetime`, `url` (http(s) only), `email`, `yesno`, `enum` (with `values`), `list`, `file`, `image`, `ref` (with
  `to`, M55), `credential` (with `for`, M57). A field may be nested by a dotted name (`company.name`). `help` (any
  field) is a line under its input on the form: what to write there.
- **References (M55):** `project: { type: ref, to: Project }` points at an entity of another type of the App: its form
  picks one from a list (by title), it holds that entity's key (`{{item.project}}` is the key), and a list can filter
  by it (`filters: [project]`, its choices the Projects). Only one that is there is saved. Deleting an entity others
  point at says how many first; they keep its key. Lists, pages and search show a ref by its entity's title (M56).
- **Matching refs, lists of refs (M56):** `path: { type: ref, to: Path, match: project }` is picked only among the
  Paths whose `project` is the entry's (both refs to the same type); the form lists them once the project is chosen,
  and the api refuses another's. `paths: { type: list, of: ref, to: Path }` holds several, in the order picked (the
  form moves them up and down); `{{item.paths}}` is their keys.
- **Credentials (M57):** `token: { type: credential, for: api.github.com }` holds one of your credentials, by id: the
  form lists the ones allowed on that host, by name, with **New** to add one there (the field's `help` on it). Only on
  a type of mine (pipelines never write which credential it is). A pipeline gets it as a handle (shown `***`), which
  `http.fetch` and `http.request` open only for a host the credential allows; it is never compared or sorted by.
- **Fields shown by others (M56):** `when: { kind: secret }` (or `{ destination: [repository, environment] }`, by an
  enum or a yes/no field) puts a field on the form only while the others are so; it is required only then.
- **Related lists (M55):** a view page's `related: [{ type: Entry, by: project, label, columns, filters, add: true }]`
  lists on a Project's page the Entries whose `project` is that Project, with their own filters; `add` adds one there,
  its `project` set and kept. M56: `add: [{ label: Add secret, set: { kind: secret } }, …]` gives a button each, its
  form with those fields set; `group: path` (an enum or a ref) shows a group for each value, or each entity (the
  Project's own Paths, as `path` matches by `project`), empty ones too, each with its buttons; an add takes the
  group and the filters chosen.
- **Files and images (M46):** uploaded on the entity's form (up to `DOWNLOAD_MAX_MB`), checked by their content: an
  `image` is a PNG, JPEG, WebP or GIF (never SVG) and gets a thumbnail, shown in lists and on its page; a `file` is
  also a PDF, an office document (DOCX, XLSX, ODT, ODS) or text (TXT, MD, CSV), a download. The entity holds
  `{ id, name, mime, size }`, never the bytes; a file replaced or cleared on the form, or whose entity or App is
  deleted, goes with it. A pipeline keeps a file with `file.keep` (an email's attachments, a download) and puts its
  reference in data.save's item; a save that doesn't name the field keeps the file there. `file.read` reads a file's
  text, `llm.extract`'s `files` shows the model its images and PDFs. Only the pipeline's own App's files.
- **Writing:** each field is read as its kind (`"4 500"` → 4500, an ISO date and time → its date); a wrong one is
  left out and said in `invalid`; an item without a required field, or without its key, isn't saved. What the type
  doesn't name is kept with the entity as it came.
- **`mine: true`:** a field you set; no pipeline can write it, and every save keeps it.
- **`encrypted: true` (M52):** a secret the App keeps, a token or a password to send elsewhere (a repository's GitHub
  secrets). Only on a `text` or `longtext` field that isn't the key, the title or a currency. It is sealed in the
  database like a credential (design.md §7), for its own entity and field: its form shows *Set, encrypted* with
  **Replace** and **Clear**, never the value; no list shows, searches, sorts, filters or groups by it; every answer of
  the api, a run's page, a gate and Telegram show `***`. In a pipeline it is the sealed value, a handle: `data.read`
  and `{{trigger.item}}` give it, `data.save` keeps it (sealing it again for another entity), `data.map` passes it on
  as it is (sealed), and a save that doesn't
  give it keeps the one there. Only `http.request` sends it, in `headers`, `query` or `body` (§4.2); `{{item.value}}`
  anywhere else is refused when the pipeline is saved, and a whole item reaching another step (an LLM's, a
  notification's) shows `***` there. `{{item.value.hash}}` is a keyed hash of the value, usable anywhere: whether it
  changed since it was last sent, without opening it. A `where` or `sort` can't name it. A version that makes a field encrypted seals the values it holds; one that stops it is
  refused while any entity holds a value (clear them, or remove the field). `pnpm keys:rotate` and `storm check` cover
  them.
- **`auto: true` on the key (M48):** Storm makes the key (12 letters and digits) when an entity is added, on its list
  or by a pipeline's item without one, so what names it (a task's title) can change. Only on a text key.
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
email re-read never moves a job back. The date each state was first reached is kept.

**You and pipelines on the same entities (M45).** The entity's form (`form:`) may hold any field but the key and the
stage (default: your `mine` fields). What you set there stays over what pipelines write, until you reset it: the
form shows what the pipeline wrote under it, with *Reset*. `add: true` on a type's list lets you add entities by hand
(*New*: the key and the form's fields) and delete them on their page, while pipelines still add and update them; a
pipeline's `data.save` on such a type can't be `complete`, since what you added isn't in its list. `mine: true` stays
the guard for what only you write: a field (no pipeline can write it, and every save keeps it) or a whole type (you
add, edit and delete its entities, pipelines only read it).
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
  Task:
    key: title
    fields: { title: { type: text, required: true }, due: { type: date }, done: { type: yesno } }
pages:
  - form: Job
    fields: [comments]
  - list: Task
    add: true                                # New on the list; a pipeline from Telegram adds them too
  - form: Task
    fields: [due, done]
  - view: Job
    actions:
      - { label: Apply, run: Job submit, when: { status: favorite }, confirm: "Apply to this job?" }
  - list: Job
    actions: [{ label: Check now, run: Job Search collect }]
```

A target (an address to send to) never comes from a type pipelines write, even an entity you added by hand to one;
from a `mine` type it may.

A list can also draw a `data.history` collection keyed by its entities above it (`chart: { history, label?, stepped? }`,
the five with the highest latest value), and *Move them here* on an App's page brings a pipeline's collection (a
`view:` page's) into one of its types: a mark on a row becomes the `mine` yes/no field of its name.

**Reports.** A `report:` page counts a type's entities over a period, picked on the page from `periods` (in days; the
first is shown first, *All time* is always offered). An entity is in the period by its `date`: a date field, or
`@firstSeen` (the default) or `@lastSeen`. Each tile measures one thing, of the entities `when` says: `count: true`,
`sum: <field>` (a number or money field; money per currency), or `reached: <state>` (or a list: any of them), which
counts the entities that were ever at that stage, wherever they are now. `of: <tile>` also shows a tile as a share of
another (counts and number sums, not money). A trend draws a measure over the period, a point per `day`, `week` or
`month`. A table shows tiles again (`columns`), a row per value of a field, the most first (an enum's in its order), or
per band of a number field (`bands`, their lower bounds). A report reads a type's newest 5000 entities, removed ones
included, and goes in the menu after the App's lists.

```yaml
pages:
  - report: Job
    menu: { label: Job report, icon: chart }   # default: "Job report"
    date: "@firstSeen"
    periods: [90, 30, 365]
    tiles:
      - { label: Found, count: true }
      - { label: Applied, reached: applied }
      - { label: Replied, reached: [responded, interview, offer, rejected], of: Applied }
      - { label: Spent, sum: fee, when: { source: board } }
    trends:
      - { label: Found, count: true, every: week }
    tables:
      - { by: score, label: By score band, bands: [80, 60, 40, 0], columns: [Found, Applied, Replied] }
      - { by: source, columns: [Found, Applied] }
```

**From a sentence (M34).** The pipeline builder proposes a whole App ("I'm looking for a job", "keep my bills") with
its pipelines, as one proposal to review and save together; *Describe a change* on an App's page asks it to change
one ("add a rating to jobs"), shown as what changes in the App and in each pipeline. It starts a type from the
schema.org type that means the same and, after a dry run, drafts it from what the source really gave. **In the data,
not in the types** on an App's page lists the fields its entities have that their type doesn't name, with *Add to the
type*.

Ready-made Apps in [examples/apps/](../examples/apps/): Job Search, Bills, Prices, Releases, Tables, Trips, Clients, Apartments, Orders, Subscriptions, Car, Server ops, Tasks, Memos, Papers, Lockbox, Follow-ups, Meetings, Quotes. Job Search
([examples/apps/job-search.yaml](../examples/apps/job-search.yaml)) is filled by a job-board pipeline
([job-board.yaml](../examples/apps/job-search.yaml): `browser.extract` with a recipe like
[recipes/example-jobs.yaml](../recipes/example-jobs.yaml), the agencies skipped, the rest scored, then `data.save` with
`type: Job`) and by [application-replies.yaml](../examples/apps/job-search.yaml). Save the App before its
pipelines.

**An App with its pipelines in one file.** **Export YAML** on an App writes this, and **Import YAML** reads it:

```yaml
app:
  name: Lockbox
  description: GitHub variables and secrets, kept here and synced when you press Sync
  icon: lock
  setup:                     # what to set up first: the checklist on the App's page
    - { kind: entities, type: GitHubOwner, label: "A GitHub owner with its token" }
types: { ... }
pages:
  - view: Bundle
    actions:
      - { label: Sync, run: sync }     # a pipeline of this file, by its key
pipelines:
  sync:
    name: Sync               # saved as "Lockbox · Sync"
    trigger: { on: entity.action, type: Bundle }
    steps: [ ... ]
```

A pipeline's key is the file's own: a button's `run:`, a `run.finished` trigger's `pipeline` and a `flow.later` step's
`pipeline` may use it, and the import puts the pipeline there by id. `app:` also takes the App's `needs` (its slots, §2.6).
`fullName` instead of `name` saves a pipeline under exactly that name. A name that isn't a key of the file is looked up as
a pipeline you have. Files with an App and its pipelines as documents with `---` between them still import.

Pipelines that depend on each other belong in the same App file, linked by their keys. A link to another App's pipeline
uses its saved name, and Storm holds it by id once both exist. A standalone pipeline is one that connects to nothing.

---

### 2.6 Credentials and settings: slots, never names (M50)

A pipeline never names one of your credentials. `{{cred:github}}` is its **slot** `github`, and you choose which of
your credentials fills it, by id: two installs of an App can use two GitHub tokens or two databases, and renaming a
credential breaks nothing. A setting (`{{setting.repository}}`) is a slot filled with text you type, so an App
installed twice can watch two repositories. When one install needs many (a token per GitHub owner), keep them as rows
instead, in a credential field (§2.5): Lockbox and Server ops do.

```yaml
needs:
  github: { kind: credential, type: api_key, for: api.github.com, label: "GitHub, to open issues" }
  repository: { kind: text, label: Repository, example: me/infra }
steps:
  - id: issue
    type: http.request
    with:
      method: POST
      url: "https://api.github.com/repos/{{setting.repository}}/issues"
      headers: { Authorization: "Bearer {{cred:github}}" }
      body: { title: "The nightly backup failed" }
```

- **`needs:`** on a pipeline, or on an App (its pipelines share them; each install fills its own): `kind: credential`
  (`type`: password, api_key, database, oauth_token, storage_state, totp_seed; `for`: the host it is for),
  `kind: text` (`example`), `kind: email`: one of your email accounts (§4.4), or `kind: google` (`uses`: calendar,
  drive): one of your Google accounts allowing them (§4.7). An account slot is the default account until you choose. A
  slot a step uses without one is added from where it is used: a database for `db.query`'s connection, the host of an
  address written in the step, an email or Google account for an email or calendar step's `account: <name>`, and text
  for `{{setting.<name>}}`. At most 20 slots; `account: topics` (every mailbox the topics read) only on `email.fetch`.
  `help` (any slot, up to 1000 characters) says what it takes to fill it, a token's permissions or where to make one:
  shown under the slot and on the form that adds a credential for it.
- **Filling them:** the **What it needs** card on the pipeline's page (its own slots; its App's are shown and filled on
  the App's page, once for all its pipelines), on the App's page, and in the builder's chat once a proposal is saved.
  Each credential slot offers only your credentials that fit (its type, the host it is for), or **Add a new one**,
  which opens the credential form with that kind and host filled in and chooses it once stored. When a pipeline or an
  App is saved, a slot exactly one of your credentials fits is filled with it; one that two fit waits for you. The api:
  `GET` and `PUT /api/pipelines/:id/bindings`, `/api/apps/:id/bindings` (`{ slot: { credentialId } }`, `{ slot: { text } }`,
  `{ slot: { emailAccountId } }`, `{ slot: { googleAccountId } }`, null clears one).
- **To the App:** on a pipeline in an App, **To <App>** next to one of its own slots makes it the App's: the App gets
  the slot, the pipeline a version without it, and what filled it goes along (unless the App's is filled already),
  so the App's other pipelines can use it too.
- **On the step cards** you pick one of your credentials that fits the step (a database for `db.query`, one allowed on
  the address's host for an API): the step gets a slot named for what it is for (`database`, `github`), filled with
  your choice when you save. You never type `{{cred:…}}`, and the builder never names a credential: it writes slots,
  and puts one several of an App's pipelines use on the App.
- **Kept filled:** a pipeline with a slot empty can't be switched on (it says which); an installed example's checklist
  lists them. A slot renamed in a new version keeps its credential when it asks for the same. The Credentials page
  shows where each credential is used, and deleting one in use names what loses it. A copy or an export carries the
  slots, never what fills them.
- **At run time** a slot without a credential, or a setting not set, fails the step saying which and where to set it. A
  credential still goes only to its allowed hosts, whatever slot it fills.

## 3. Triggers: what starts a pipeline

| Trigger | Starts when | `{{trigger.*}}` holds |
| --- | --- | --- |
| `manual` (default) | You press Run, or send `/run <name>` on Telegram | — |
| `{ schedule: "0 8 * * 1-5", tz: Europe/Sofia }` | A five-field cron time, in `tz` (default: the server's time zone) | — |
| `{ on: run.finished, pipeline: Bills, status: [FAILED] }` | Another pipeline's run ends (default: only `DONE`) | `runId`, `pipeline`, `status`, `summary` (for a failed run, the step and its error), `outputs` |
| `{ on: application.status, status: [SUBMITTED] }` | One of your applications changes status | `applicationId`, `status`, `job` (title, company, location, url) |
| `{ on: recipe.broken, site: jobs.example.com }` | A browser recipe stops matching its site | `site`, `recipe`, `version`, `reason`, `fixProposed` |
| `{ on: email.classified, label: [interview] }` | An `email.classify` step labels an email | `label`, `reason`, `message` (the email) |
| `{ on: flow.later }` | Another pipeline's `flow.later` fires | `data`, `key`, `scheduledAt`, `scheduledByRunId` |
| `{ on: view.action, collection: releases }` | A row's button on a pipeline's page | `collection`, `key`, `item` (the row), `action` |
| `{ on: entity.changed, type: Job, field: salary, stage: interview }` | An entity of the pipeline's App is added or changed, by another pipeline or by you (`field`: only changes of it; `stage`: only a move into it) | `app`, `type`, `key`, `item`, `before` (null when added), `changed` (field names), `by`, `stage` (`from`, `to`, or null) |
| `{ on: entity.action, type: Job }` | An entity's button on its page | `app`, `type`, `key`, `item`, `action` |
| `{ on: telegram.command, command: task, description: "Add a task" }` | You send `/task Buy milk` to the Storm bot, maybe as a photo's or a file's caption (M49). Only while the pipeline is on; a command is one pipeline's (switching on a second with it is refused, with a name to use instead); it is in the bot's menu with its `description`. Never one of the bot's own (`/run`, `/inbox`, …) | `command`, `text` (what follows it: data, never a target), `file` (a photo or file sent with it, for `file.keep`'s `telegram`; null without one), `messageId`, `sentAt` |
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
- In: `items`, `into` [JobPosting], `status` [NEW], `collection`, `key`, `fields`, `complete` [false], `type`, `stage`.
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
- **An App's credential or encrypted field (M57)** goes in `headers` or `query` too, as `{{owner.value.token}}`:
  opened only as the read is sent, a credential only to the hosts it allows (each redirect too); never cached.

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
A header whose value the data doesn't have (`{{item.authorization}}` left empty) isn't sent (M58). An answer other
than 2xx fails the step with its status.
- **An App's encrypted field (M52)** goes in `headers`, `query` or `body` as `{{item.value}}`, alone or inside text
  (`"token {{item.value}}"`). The gate shows `***`; the worker decrypts it only once you press Act and sends the real
  value; an answer echoing it shows `***`. An edit at the gate that leaves `***` keeps the value. With a transform
  (§2.1), `{{item.value | sealedBox: key.json.key}}` sends it sealed to an API's public key instead (GitHub's secrets),
  `{{item.value | base64}}` as base64.
- **An App's credential field (M57)** (`{{owner.token}}`, from `data.read` or a trigger) is sent the same way: the
  worker opens the credential it names only for the request's host, which the credential must allow; else the step
  fails and nothing is sent.
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

#### `http.check`
Whether a web address answers (an uptime monitor, M47): `state` up or down, the HTTP `status`, `ms` to the answer, and
for https the certificate's expiry. Up: the status is `expect`, else any 2xx or 3xx; redirects are followed (each
address checked again), at most 5. It never fails the step: a timeout, a refused connection or a bad certificate are
`down`, with the `error`. It never reads the page. The address is written in the pipeline or is exactly a field of
mine of an App entity (`{{item.url}}` over `data.read`'s items, `{{trigger.item.url}}`): only such an address may be
private, on your LAN or Tailscale; loopback, link-local and a cloud's metadata never (`refused`: true).
- In: `url`, `method` [GET; or HEAD], `expect`, `ignoreTlsErrors` [false: a self-signed certificate is down],
  `timeoutSeconds` [10].
- Out: `state`, `up`, `status`, `ms`, `error`, `refused`, `checkedAt`, `address` (the IP it connected to),
  `certExpires` (YYYY-MM-DD), `certDays`.

#### `net.check`
Whether a host answers: `kind: tcp`, a connection to `port`, or `kind: ping`, one ICMP echo. The same address rules
and output as `http.check` (without status and certificate). Ping works in the Docker image without any capability
(unprivileged ICMP); where it can't, the check says so: check a port instead.
- In: `host`, `kind` [tcp], `port`, `timeoutSeconds` [5].
- Out: `state`, `up`, `ms`, `error`, `refused`, `checkedAt`, `address`.

```yaml
# Your Monitors (Server ops), checked every five minutes: examples/apps/server-ops.yaml
- id: web
  type: data.read
  with: { type: Monitor, where: [{ field: kind, op: eq, value: http }] }
- id: check
  type: http.check
  forEach: "{{web.items}}"
  with: { url: "{{item.url}}", expect: "{{item.expect}}" }   # url is mine: you typed it on the Monitors page
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
- In: `url`, `urls` or `products` (each with its own `select`), `browser` [`fallback`, or `always`/`never`], `llm` [true],
  `timeoutSeconds` [30].
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
Checks your watched **Products** in the pipeline's App (M33: save [examples/apps/prices.yaml](../examples/apps/prices.yaml)
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
as ISO 8601 with an offset. `files` (M46): up to 5 of an entity's images and PDFs (its App's file and image fields),
which the model sees as well: a receipt's photo, a warranty's PDF. Like any content, they are data, never
instructions.
- In: `content` and/or `files`, `fields`, `instruction`, `timeZone` [the server's time zone].
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

# What a receipt says (an App's Paper, read from its document field: a photo or a PDF)
- id: read
  type: llm.extract
  with:
    files: ["{{trigger.item.document}}"]
    fields: { merchant: the shop, amount: the total paid, warrantyUntil: when the warranty ends }
```

### 4.4 Email

Reading uses IMAP and sending uses SMTP, through one of your **email accounts** (Settings → Email accounts: Gmail
with an [app password](https://myaccount.google.com/apppasswords), or any server with IMAP and SMTP over TLS; its
password is stored encrypted, like a credential). One of them is the default. Reading never marks or moves anything.

Which account: an email step's `account` is an email slot, written as a name (`account: work`), which you fill on the
pipeline's or its App's page, like a credential's (§2.6); left out, or not filled, the default account. Every email
read carries the `account` it came from, so a reply goes out from the same one: `account: "{{item.account}}"` on
`email.send`. Steps that open an email again (a thread, its attachments) use its account by themselves.

#### `email.fetch`
The emails that arrived since this pipeline's last run (the first run looks back `sinceDays`), oldest first, so each
email is read once. Text only: attachments are listed, not downloaded. `mailbox: Sent` reads your server's Sent folder,
whatever it is called there (`[Gmail]/Sent Mail`, a translated name): the emails you wrote.
- In: `mailbox` [INBOX], `limit` [50], `sinceDays` [2], `account` (an email slot; `topics`: every mailbox your topics
  read, their **Mailbox** sources, and the default account for a topic without one; default: the default account). Each
  account it reads keeps its own place.
- Out: `messages` (uid, messageId, threadId, from, fromName, replyTo, to, cc, subject, date, text, attachments,
  account, …).

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
Sends an email from one of your email accounts. With `inReplyTo` and `references` it is a reply in the same thread;
`account: "{{item.account}}"` sends it from the account the email came to (for `email.awaiting`'s threads,
`{{item.message.account}}`). `to` must come
from real data (e.g. `{{item.from}}`), a literal, or `policy.allowedRecipients`. A reply is never sent to a no-reply
address or to your own address: the step fails with why.
- In: `to`, `subject`, `body`, `inReplyTo`, `references`, `account` (an email slot, or `{{item.account}}`; default:
  the default account).
- Out: `messageId`, `accepted`, `from` (the address it went from).

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
  `maxFollowUps` [1], `limit` [5], `account` (an email slot; default: the default account), `remember` [true]: false
  lists every unanswered thread each time and remembers none, for an App whose rows keep track (snoozed, dropped).
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
    account: "{{item.message.account}}"   # from the account the thread is in
```

#### `topic.match` 🧠
Which of your topics (the Topics page; docs/design.md §8.1) each email belongs to. The directions you gave come first,
without an LLM: a word in the subject or text, anyone at a domain, a person; an email whose thread already belongs to a
topic belongs to it too. The cheap model looks only at emails no direction settles (a thread's later email included, in
case the conversation moved to another subject), with each topic's description and directions. An email can belong to
several topics, and to none, which is normal; only to the topics that read its mailbox (their Mailbox sources, else the
default account). Found by a direction or the thread: linked; only by the model: suggested,
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
history, superseded) or a conflict (both in dispute until you say which holds, on the topic's page). From `topic.tidy`:
a merge (the facts superseded by the one that says them together) or a retired fact (superseded, kept in the history).
Evidence counts by the date of its source, not the order it was read in: a change from an email older than the fact it
replaces goes into the history. A merge or retirement of a fact that changed since it was proposed is skipped. Each one
is a change on the topic's page that you can undo. A proposal no gate of the run approved is not written; a dry run
writes nothing.
- In: `proposals` (the gate's `selected`).
- Out: `applied` (how many), `skipped` (each with why: already known, you said it was wrong, a fact it tidies has
  changed since, not approved).

#### `topic.tidy` 🧠
A tidy-up of your topics' facts, for a weekly pipeline. For each active topic with more current facts than a draft has
room for (the topic's page says when), the writing model proposes to **merge** facts that say parts of one thing into
one statement, keeping every detail, and to **retire** facts that no longer hold: a date that has passed and that
nothing depends on, a status a later fact overtook. Each proposal says why. Topics whose facts all fit aren't read, so
most weeks cost nothing. Facts in dispute are left to you. What you left out at an earlier gate of the same pipeline
isn't proposed again (until one of its facts changes). It writes nothing: approved at a gate.review, `topic.apply` does.
A merged fact is yours (approved wording), pinned if one of the facts it merges was.
- In: `topics` (only these, by name, tidied even when their facts fit; default: every active topic with more than fit).
- Out: `proposals` (for gate.review, then topic.apply), `title` ("Tidy-up: 4 proposals for Orion", for the gate),
  `topics` (the topics read: how many facts, how many fit).

```yaml
- id: tidy
  type: topic.tidy
  with: {}
- id: review
  type: gate.review
  when: "{{tidy.proposals}}"
  with: { items: "{{tidy.proposals}}", title: "{{tidy.title}}" }
- id: apply
  type: topic.apply
  when: "{{tidy.proposals}}"
  with: { proposals: "{{review.selected}}" }
```

#### `git.changes`
The files changed in your topics' GitHub sources (on the Topics page: a repository, a path like `docs/adr/**`, a branch)
since each was last indexed, at its branch's head: text files under its path only (Markdown, AsciiDoc, plain text). The
first read lists every one. Seeing that nothing changed is one call to GitHub, no LLM. A private repository needs a
read-only token, kept as a credential allowed for `api.github.com` only and chosen on the source by id (renaming it
breaks nothing; deleting it leaves the source without one). It only reads: `topic.index` moves each source on
once its files are indexed, so a failed index is read again next time.
- In: `topics` (only these, by name; default: every active topic).
- Out: `changes` (topic, repo, path, added / modified / removed, commit, its date, link), `sources` (each source read,
  from which commit to which), `problems`.

#### `drive.changes`
The files changed in your topics' Google Drive sources (on the Topics page: a folder by its link, and optionally a path
like `Specs/**`) since each was last indexed: Google Docs (exported as Markdown), Slides, PDFs and text files, in the
folder or its subfolders. Each folder is read through the Google account chosen for it when it was added (else your
default one), which must allow Drive (read-only; Settings shows it, [google-setup.md](google-setup.md)). Seeing that nothing changed is one call to Drive's changes list, no LLM, however
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
Keeps bills as **Bill entities of the pipeline's App** (M33: save [examples/apps/bills.yaml](../examples/apps/bills.yaml)
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

Needs a Google account connected in Settings, allowing the calendar (see [google-setup.md](google-setup.md)). You can
connect several; one is the default. A calendar step's `account` is a google slot, written as a name (`account: work`),
which you fill on the pipeline's or its App's page with one of your accounts that allows the calendar (§2.6); left out,
or not filled, the default account. `calendar` is which of the account's calendars, by its id (Google Calendar → the
calendar's settings → Calendar ID): usually a setting, `calendar: "{{setting.calendar}}"`; left out, the primary one.

#### `calendar.find`
Your events between `from` and `to` (default: the next 7 days), optionally matching `query`. `durationMinutes` gives a
window from `from`, to see what an event at that time would clash with.
- In: `from`, `to`, `durationMinutes`, `query`, `timeZone`, `maxResults` [50], `account`, `calendar` [primary].
- Out: `events` (id, title, start, end, allDay, location, link, meetLink, attendees, organizer), `count`, `none`.

#### `calendar.create` ⚡
Creates an event. With `attendees`, Google emails them an invitation from your account. An event with the same title at
the same start isn't created twice.
- In: `title`, `start`, `end` or `durationMinutes` [60], `timeZone`, `description`, `location`, `attendees`, `meet`
  [false], `sendInvites` [true], `account`, `calendar` [primary].
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
In a dry run (a recipe's **Try**, or Try in the pipeline editor) it reads the same but leaves the recipe as it is: not
marked as working or broken, nobody told, no `recipe.broken`, no fallback.
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

The guide to recipes, from teaching one to fixing it: [recipes.md](recipes.md). A recipe
([recipes/example-jobs.yaml](../recipes/example-jobs.yaml)) names the list's address, its params, the item
selector, each field's selector, the key, how to reach the next page, and a polite delay between pages. The next page
is a link (`{ kind: link, selector: a.next }`), a page number in the address (`{ kind: page, url: "…&page={page}" }`),
or more items on the same page: a "Load more" button pressed (`{ kind: more, selector: button.load-more }`) or the page
scrolled to its bottom (`{ kind: scroll }`); each press or scroll counts as a page, and the list ends when the button is
gone or nothing new comes. Teach mode writes the first two; the others are set by editing the recipe.

#### `browser.details` 🖥️
Opens each item's own page and adds more fields to the item, as the recipe's `detail` section says: a job ad's
description, a listing's floor. Headless, no LLM, at the recipe's pace, on the recipe's site only. Put it after
`data.dedupe`, so only new items are opened (each page once). Items over `maxItems`, without a link, off the site, or
whose page fails come back as they were. When none of the pages opened has the fields, the item pages changed: the step
fails saying so (edit the recipe's `detail`). A recipe's **Try** opens the first 5 items' pages too.
- In: `recipe`, `items`, `maxItems` [20, at most 100], `timeoutSeconds` [30].
- Out: `items` (every item given; those opened with the detail fields), `opened`, `found`.

```yaml
- id: search
  type: browser.extract
  with: { recipes: [jobs.example.com/search], params: { category: net } }
- id: fresh
  type: data.dedupe
  with: { from: "{{search.items}}", key: url, against: JobPosting }
- id: more
  type: browser.details
  with: { recipe: jobs.example.com/search, items: "{{fresh.items}}", maxItems: 30 }
```

The recipe names the field with each item's link (`url` if left out) and the fields to read on its page, new names, not
the list's:

```yaml
detail:
  link: url
  fields:
    description: { selector: .job-description, required: true }
    salary: { selector: .salary }
```

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
Reads the text of a stored document (Documents page, e.g. `cv-main`), of a file `browser.download` kept, or of an
entity's file of the pipeline's App (`file: "{{item.receipt}}"`, M46). Text files as they are, PDFs' text (an image:
`llm.extract`'s `files`). Its output also binds the document by content, so `browser.upload` sends exactly the version
you approved.
- In: `document`, `artifact` or `file`, `maxChars` [20000].
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

#### `file.keep`
Keeps an email's attachments (`message`, read from `mailbox`), a file `browser.download` kept (`artifact`) or a photo or
file sent to the Storm bot with a command (`telegram: "{{trigger.file}}"`, M49; null keeps nothing) as files of the
pipeline's App, for a type's file or image `field` (M46). Checked by content: an image field takes only PNG,
JPEG, WebP or GIF; a file field also PDFs, office documents and text. Their references go into that field of
`data.save`'s items, which attaches them to the entity; kept files no entity takes are removed after a day. Nothing
leaves Storm. A dry run keeps nothing and says how many it would.
- In: `type`, `field`, `message`, `artifact` or `telegram`, `mailbox` [INBOX], `max` [5].
- Out: `files` (`{ id, name, mime, size }` each), `first` (or null), `found`, `skipped` (name and why).

```yaml
# A receipt by email becomes a Paper with its PDF
- id: keep
  type: file.keep
  forEach: "{{receipts.kept}}"
  with: { type: Paper, field: document, message: "{{item}}" }
- id: save
  type: data.save
  forEach: "{{receipts.kept}}"
  with:
    type: Paper
    items: [{ title: "{{item.subject}}", document: "{{keep.first}}" }]   # this email's file
```

### 4.10 You in the loop

#### `gate.review`
Pauses the run and shows a list; you pick which items go on.
- In: `items`, `title`, `mode` [select].
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
- **A batch (M53):** over a list, every item waits at once, each with its own payload. The inbox shows them as one card
  (untick the ones you don't want, then **Approve**: the rest are rejected), and Telegram as one message with
  **Approve all**. Open an item alone to edit it.

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
Sends you a Telegram digest of the last `hours`: what ran, what waits for you, what failed (runs that failed, and
runs done with failed items).
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
- In: `pipeline`, `after` or `at`, `timeZone`, `data`, `key`, `cancelOn` (`{ event, match }`; `event`: run.finished,
  application.status, recipe.broken or email.classified).
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
| Draft replies to recruiters and clients, send after you approve | `email.fetch` → `email.classify` → `topic.match` (the email of your topics is left to Topic replies) → `email.draftReply` → `email.send` | [recruiter-replies.yaml](../examples/pipelines/recruiter-replies.yaml) |
| Draft replies to the email of your topics with what Storm knows about them, send after you approve | `email.fetch` → `email.classify` → `topic.match` → `email.draftReply` (`topic: auto`, on `linked`) → `email.send` | [topic-replies.yaml](../examples/pipelines/topic-replies.yaml) |
| Find new jobs, score them, let you pick, fill the forms | `browser.extract` → `data.dedupe` → `llm.classify` → `llm.score` → `data.save` → `gate.review` → `browser.mapForm` → `browser.fillAndSubmit` | the Job Search App ([job-search.yaml](../examples/apps/job-search.yaml)) with a job-board recipe ([example-jobs.yaml](../recipes/example-jobs.yaml)) and [job-board.yaml](../examples/apps/job-search.yaml) up to `data.save` |
| Track answers to your applications | `email.fetch` → `email.classify` → `application.outcome` → `notify.telegram` | [application-replies.yaml](../examples/apps/job-search.yaml) |
| Keep what is true about your topics (a project, a customer) from your email, with your approval, for your drafts to use | `email.fetch` (INBOX, and Sent: what you wrote) → `email.classify` → `topic.match` → `topic.attachments`; `git.changes`, `drive.changes` → `topic.index`; → `topic.extract` → `gate.review` → `topic.apply` (drafts: `email.draftReply` with `topic: auto`) | [topic-upkeep.yaml](../examples/pipelines/topic-upkeep.yaml) |
| Each week, merge your topics' overlapping facts and retire stale ones, with your approval | `topic.tidy` → `gate.review` → `topic.apply` | [topic-tidy.yaml](../examples/pipelines/topic-tidy.yaml) |
| Nudge people who didn't answer your emails | `email.awaiting` → `email.draftFollowUp` → `email.send` | [email-follow-ups.yaml](../examples/pipelines/email-follow-ups.yaml) |
| Your emails nobody answered, listed; every Monday a nudge for each, approved as one batch (the ones you untick snoozed for two weeks); Snooze or Drop a row, at most two nudges a thread | `schedule` → `email.awaiting { remember: false }` → `data.read` → `data.map` → `data.save` → `email.draftFollowUp` → `email.send` (one batch at the gate) → `data.save { stage }`; `entity.changed { stage: snoozed }` → `flow.later`; `{ on: flow.later }` → `data.read` → `data.save { stage }` | the Follow-ups App ([follow-ups.yaml](../examples/apps/follow-ups.yaml)) with [follow-ups.yaml](../examples/apps/follow-ups.yaml), [snooze.yaml](../examples/apps/follow-ups.yaml), [wake.yaml](../examples/apps/follow-ups.yaml) |
| Emails asking to meet answered with three times your calendar has free; the time they choose booked as an event with them invited (a Meet link); one nudge when they don't answer in 3 days; each reply, event and nudge approved first | `schedule` → `email.fetch` → `data.read` → `data.map` → `email.classify` → `calendar.find` → `email.draftReply` → `email.send` → `data.save`; their answer → `llm.extract` → `calendar.create` (attendees from the email) → `data.save { stage }`, `notify.telegram` without a time; `schedule` → `email.awaiting { remember: false }` → `email.draftFollowUp` → `email.send` | the Meetings App ([meetings.yaml](../examples/apps/meetings.yaml)) with [meetings.yaml](../examples/apps/meetings.yaml), [meeting-nudge.yaml](../examples/apps/meetings.yaml) |
| A request for quotes sent to the suppliers you pick (one batch); their answers read into quotes (price, delivery, terms), side by side on the request's page; the one you accept told and the others thanked, each email approved first and only to your suppliers' addresses | `entity.action` → `data.read` (a `mine` type: the addresses) → `data.map` → `email.send` (one batch) → `data.save`; `schedule` → `email.fetch` → `data.read` → `data.map` (an answer by its thread) → `llm.extract` → `data.save { stage }` → `notify.telegram`; `entity.action` → `data.read` → `email.send` (accept), `email.send` (the others) → `data.save { stage }` | the Quotes App ([quotes.yaml](../examples/apps/quotes.yaml)) with [quote-ask.yaml](../examples/apps/quotes.yaml), [quote-read.yaml](../examples/apps/quotes.yaml), [quote-accept.yaml](../examples/apps/quotes.yaml) |
| Turn interview invitations into calendar events with prep notes | `email.fetch` → `email.classify` → `llm.extract` → `calendar.find` → `llm.generate` → `calendar.create` | [interview-invite.yaml](../examples/pipelines/interview-invite.yaml) |
| Keep your bills, with a reminder before they're due | `email.fetch` → `email.classify` → `bill.read` → `bill.save` → `calendar.create` / `notify.telegram` | [bills.yaml](../examples/apps/bills.yaml) |
| Keep your trips' bookings from email, with a reminder the day before each, a weather briefing three days before a trip and a packing list on a button | `email.fetch` → `email.classify` → `llm.extract` → `data.map` → `data.save` → `calendar.create`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel`; `http.fetch` (Open-Meteo) → `data.read` → `llm.generate` → `notify.telegram` | the Trips App ([trips.yaml](../examples/apps/trips.yaml)) with [trip-bookings.yaml](../examples/apps/trips.yaml), [trip-booking-reminders.yaml](../examples/apps/trips.yaml), [trip-countdown.yaml](../examples/apps/trips.yaml), [trip-briefing.yaml](../examples/apps/trips.yaml), [packing-list.yaml](../examples/apps/trips.yaml) |
| Freelance work: inquiries become scored leads, a proposal and a payment reminder to a client you added, an invoice draft for a won lead, watched until paid | `email.fetch` → `email.classify` → `data.read` → `llm.extract` → `data.map` → `data.save`; `entity.action` → `data.read` (a `mine` type: its address may be a target) → `llm.generate` → `email.send` → `data.save { stage }`; `entity.changed { stage: won }` → `data.map` → `data.save`; `data.read` → `data.map` → `data.save { stage: overdue }` | the Clients App ([clients.yaml](../examples/apps/clients.yaml)) with [client-inquiries.yaml](../examples/apps/clients.yaml), [proposal.yaml](../examples/apps/clients.yaml), [lead-won.yaml](../examples/apps/clients.yaml), [overdue-invoices.yaml](../examples/apps/clients.yaml), [payment-reminder.yaml](../examples/apps/clients.yaml) |
| Find a place to rent: new listings marked against what you look for, price drops on your favorites, a request for a viewing to an agent you added, the viewing in your calendar | `browser.extract` → `data.history` → `data.dedupe { againstType }` → `llm.classify` → `data.map` → `data.save`; `entity.action` → `data.read` (a `mine` type) → `llm.generate` → `email.send` → `data.save { stage }`; `entity.changed { field }` → `calendar.create` | the Apartments App ([apartments.yaml](../examples/apps/apartments.yaml)) with a listing site's recipe ([example-listings.yaml](../recipes/example-listings.yaml)), [listings.yaml](../examples/apps/apartments.yaml), [ask-for-viewing.yaml](../examples/apps/apartments.yaml), [viewing.yaml](../examples/apps/apartments.yaml), [compare-favorites.yaml](../examples/apps/apartments.yaml) |
| Keep your online orders from the shops' emails, each email merged into its order, with a reminder before the return window closes | `email.fetch` → `email.classify` → `data.read` → `llm.extract` → `data.map` (merged into the saved entity: `data.save` writes it whole) → `data.save`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel` | the Orders App ([orders.yaml](../examples/apps/orders.yaml)) with [orders.yaml](../examples/apps/orders.yaml), [return-window.yaml](../examples/apps/orders.yaml), [return-reminder.yaml](../examples/apps/orders.yaml), [return-request.yaml](../examples/apps/orders.yaml) |
| Keep what you pay for every month or year, with its price history, a reminder before a trial ends or a yearly renewal, and a monthly review | `email.fetch` → `email.classify` → `data.read` → `llm.extract` → `data.map` (merged, a month's price) → `data.history` → `data.filter` → `data.save`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel`; `data.read` → `data.map` (totals per currency) → `llm.generate` | the Subscriptions App ([subscriptions.yaml](../examples/apps/subscriptions.yaml)) with [subscriptions.yaml](../examples/apps/subscriptions.yaml), [renewal-watch.yaml](../examples/apps/subscriptions.yaml), [renewal-reminder.yaml](../examples/apps/subscriptions.yaml), [subscription-review.yaml](../examples/apps/subscriptions.yaml), [cancel-subscription.yaml](../examples/apps/subscriptions.yaml) |
| Your car's papers and services: told a month and a week before one runs out (or 1 000 km before a service) and when it's renewed, each date in your calendar | `data.read` (two `mine` types) → `data.map` (days and km left) → `data.alert` → `notify.telegram`; `entity.changed { field }` → `data.map` → `calendar.create` | the Car App ([car.yaml](../examples/apps/car.yaml)) with [car-papers-due.yaml](../examples/apps/car.yaml), [paper-in-calendar.yaml](../examples/apps/car.yaml) |
| Tasks by due date, open until done, added from your phone, the ones due told every morning | `telegram.command` → `data.map` → `data.save`; `schedule` → `data.read` → `data.map` → `notify.telegram` | the Tasks App ([tasks.yaml](../examples/apps/tasks.yaml)) with [task-from-telegram.yaml](../examples/apps/tasks.yaml), [tasks-due.yaml](../examples/apps/tasks.yaml) |
| Notes with a photo, newest first, kept from your phone | `telegram.command` → `file.keep { telegram }` → `data.map` → `data.save` | the Memos App ([memos.yaml](../examples/apps/memos.yaml)) with [memo-from-telegram.yaml](../examples/apps/memos.yaml) |
| Receipts, warranties and contracts read from their photo or PDF (sent from your phone too), a warranty's end in your calendar, a claim or a cancellation to the merchant you chose, a reminder before a contract's notice runs out, last month's expenses to your accountant | `telegram.command` → `file.keep { telegram }` → `data.save`; `entity.changed { field: document }` → `llm.extract { files }` → `data.save`; `entity.changed { field: warrantyUntil }` → `data.map` → `calendar.create`; `entity.action` → `data.read` (a `mine` type: its address may be a target) → `llm.generate` → `email.send`; `entity.changed` → `data.map` → `flow.later` / `flow.cancel`; `schedule` → `data.read` → `data.map` → `gate.review` → `data.map` → `email.send` (to `{{setting.accountant}}`) | the Papers App ([papers.yaml](../examples/apps/papers.yaml)) with [paper-from-telegram.yaml](../examples/apps/papers.yaml), [read-paper.yaml](../examples/apps/papers.yaml), [warranty-in-calendar.yaml](../examples/apps/papers.yaml), [warranty-claim.yaml](../examples/apps/papers.yaml), [contract-cancel.yaml](../examples/apps/papers.yaml), [contract-watch.yaml](../examples/apps/papers.yaml), [contract-reminder.yaml](../examples/apps/papers.yaml), [expense-report.yaml](../examples/apps/papers.yaml) |
| Your projects' GitHub variables and secrets kept here (secrets encrypted) by path and environment, sent to a repository, one of its environments, an organisation or Dependabot when you press Sync, with the token of its GitHub owner (a credential field); a later path overrides an earlier one; never deletes | `entity.action` → `data.read` → `data.map` → `http.fetch` (the public key, the variables there) → `http.request` with `{{item.secret \| sealedBox: key.json.key}}`, `onError: continue`, auto-approved (§2.3) | the Lockbox App ([lockbox.yaml](../examples/apps/lockbox.yaml)) with [lockbox-sync.yaml](../examples/apps/lockbox.yaml) |
| Your monitors (web addresses, ports, ping; on your network too) checked every five minutes, with their response times; incidents on what you run, each resolved when its cause is gone: a monitor down, a database check above 0, the database out of reach; a monitor's runbooks (your restart or redeploy webhook) proposed when it goes down; a GitHub issue after you approve it, in the monitor's repository (or the default one) with its GitHub owner's token, and the week in numbers | `schedule` → `data.read` → `http.check`, `net.check` → `data.map` → `data.save`, `data.history`; `{ webhook: token }` → `data.read` → `data.map` → `data.save`; `db.query` → `data.alert` → `data.map` → `data.save`; `run.finished { status: [FAILED] }` → `data.save`; `entity.action` → `data.read` (repositories, GitHub owners with a credential field) → `data.map` → `http.request` → `data.save { stage }`, `notify.telegram` when there is none; `entity.changed { stage: open }`, `entity.action` → `data.read` (a `mine` type, its encrypted token in a header) → `http.request` → `notify.telegram` → `data.save { stage }` | the Server ops App ([server-ops.yaml](../examples/apps/server-ops.yaml)) with [check-monitors.yaml](../examples/apps/server-ops.yaml), [monitor-alerts.yaml](../examples/apps/server-ops.yaml), [database-check.yaml](../examples/apps/server-ops.yaml), [database-down.yaml](../examples/apps/server-ops.yaml), [incident-issue.yaml](../examples/apps/server-ops.yaml), [ops-week.yaml](../examples/apps/server-ops.yaml), [fix-offer.yaml](../examples/apps/server-ops.yaml), [fix.yaml](../examples/apps/server-ops.yaml) |
| Tell you when a watched product is worth buying | `price.watch` → `notify.telegram` | [prices.yaml](../examples/apps/prices.yaml) |
| Prices of a shop's list, or of specific products | `browser.extract` or `shop.product` → `data.history` → `data.filter` → `llm.generate` → `notify.telegram` | [price-watch.yaml](../examples/pipelines/price-watch.yaml), [product-watch.yaml](../examples/pipelines/product-watch.yaml) |
| New releases of your stack, with a page and buttons | `http.fetch` → `data.save` → `llm.summarize` → `notify.telegram`, plus `view` | [release-watch.yaml](../examples/apps/releases.yaml), [release-notes.yaml](../examples/apps/releases.yaml) |
| Email you when it will be colder than 10° in the next 12 hours, and when it's back | `http.fetch` → `data.map` → `data.alert` → `email.send` | [cold-weather.yaml](../examples/pipelines/cold-weather.yaml) |
| Open a GitHub issue when a pipeline fails, after you approve it | `http.request` on a `run.finished` trigger | the Releases App ([releases.yaml](../examples/apps/releases.yaml)) |
| Tell you when a table grows much faster than usual | `db.query` → `data.history` → `data.alert` → `notify.telegram` | [table-growth.yaml](../examples/apps/tables.yaml) |
| An evening summary of everything | `notify.digest` | [daily-digest.yaml](../examples/pipelines/daily-digest.yaml) |
| Check the live browser handover | `browser.open` (headed) | [live-view-check.yaml](../examples/pipelines/live-view-check.yaml) |

### What it can't do

- Anything that isn't a catalog step. The builder can only combine these steps; it can't write code. It reads any
  API with `http.fetch` and changes things with `http.request` (with a key from a credential), always after you
  approve.
- Send, submit, upload or create events without your approval.
- Message anyone on Telegram but you.
- Read hosts that aren't allowed, or private network addresses (a check only asks whether an address you typed
  answers, §2.3).
- Pay bills, move or delete emails, or mark them read.
- Reach a server on your private network or VPN (Home Assistant, a NAS) with `http.fetch` or `http.request`. A
  database there is reachable with `db.query`, because its credential names the host.
- Write to a database: `db.query` only reads.
- Send an `http.request` without your approval, or follow its redirects.
