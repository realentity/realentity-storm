# Telegram: what the Storm bot does and what you can do with it

Storm has its own Telegram bot. It does three jobs:

1. **It tells you things**: proposals waiting for approval, runs that need you, questions only you can answer,
   alerts, and a brief every morning, a digest every evening and a review every week.
2. **It takes commands**: start a pipeline, check status, read the inbox, use the kill switch.
3. **It builds pipelines**: a message that isn't a command goes to the pipeline builder, and you can save or dry-run
   what it proposes without leaving the chat.

It talks only to you. Anything from another user, a group chat, or a forwarded chat is ignored and gets no answer.

---

## 1. Setup (once)

| Variable | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The bot's token from @BotFather |
| `TELEGRAM_CHAT_ID` | **Your Telegram user id**. In a private chat with the bot this is also the chat id |
| `TELEGRAM_WEBHOOK_SECRET` | The `secret_token` the webhook was registered with (`setWebhook`) |

Without the token and chat id, nothing is sent and the bot ignores all messages. Pipelines still run.

With only the token and chat id (no webhook), the bot **sends** messages but cannot **receive** them: you get
notifications, but commands, buttons and the builder don't work.

Inbound path: Telegram → your public hooks address (a tunnel, a proxy or a gateway) → Storm's hooks-only site
(`127.0.0.1:7101`, `POST /hooks/*` only) → api `POST /api/hooks/telegram`. The api checks the secret header and your
user id. See [self-hosting.md](self-hosting.md) ("Webhooks and Telegram") for the setup and `setWebhook`.

**Setting:** *Settings → Approve on Telegram* turns the Approve/Reject buttons on proposals on or off (default: on).
*Settings → Morning brief* and *Weekly review* turn those messages on or off.

---

## 2. Commands

| Command | What it does |
| --- | --- |
| `/run <pipeline>` | Starts a saved pipeline by its full name or the start of its name |
| `/status` | Kill switch state, number of running and waiting runs, pending proposals, the last 5 runs |
| `/inbox` | The proposals waiting for you: one message each with buttons (up to 5), or a list if there are more |
| `/pause` | Turns the kill switch **on**: nothing runs or acts, and running runs are stopped |
| `/resume` | Turns the kill switch **off**: pipelines run again (stopped runs stay stopped) |
| `/new` | Starts a new chat with the pipeline builder |
| `/edit <pipeline>` | Starts a builder chat about an existing pipeline |
| `/help` (or any unknown command) | Lists the commands, your pipelines' too |
| *your pipelines' commands* | `/task Buy milk`, `/memo …`, `/paper …`: a pipeline triggered by `{ on: telegram.command, command: task }` (see below), while it is on |
| *a photo or a file with a command as its caption* | The same, with the photo or file: `/paper Washing machine` under a receipt's photo |
| *any other text* | Goes to the pipeline builder (see §4) |
| *a reply to a question* | Answers the question (see §3.3) |

Rules:
- Commands older than **5 minutes** are dropped. This happens when the bot couldn't be reached and Telegram sends
  them later.
- Pipeline names don't need to match exactly. `/run price` works if exactly one pipeline starts with "price". If more
  than one matches, or none does, the bot lists your pipelines.

### Your own commands

A pipeline triggered by `{ on: telegram.command, command: task, description: "Add a task" }` is started by `/task`,
with what follows it as `{{trigger.text}}` and a photo or file sent with it (the command as its caption) as
`{{trigger.file}}`, which `file.keep` stores in an App. Rules:

- Only while the pipeline is **on**, and only from your own chat, like every command.
- One pipeline per command: switching on a second pipeline with `/task` is refused, with a name to use instead
  (`/tasks_task`). The bot's own commands (`/run`, `/inbox`, …) can't be taken.
- The bot's menu (the `/` button in the chat) follows: Storm updates it when a pipeline with a command is switched on
  or off, saved, or deleted.
- The Tasks, Memos and Papers examples come with `/task`, `/memo` and `/paper`: switch those pipelines on.

### Examples

```
You:  /run release
Bot:  Started Release watch.
      [Open the run]
```

```
You:  /run p
Bot:  "p" could be: Price watch, Product watch. Pipelines: Bills, Daily digest, Price watch, Product watch, Release watch, …
```

```
You:  /status
Bot:  Kill switch: off
      Running or queued: 1 · waiting for you: 0 · proposals: 3

      Last runs:
      • Release watch: SUCCEEDED (telegram, 2026-11-02 08:14 UTC)
      • Daily digest: SUCCEEDED (schedule, 2026-11-01 17:00 UTC)
      • Price watch: FAILED (schedule, 2026-11-01 08:00 UTC)
      [Open Storm]
```

```
You:  /pause
Bot:  Kill switch on: nothing runs or acts. 2 run(s) stopped.

You:  /resume
Bot:  Kill switch off: pipelines run again (stopped runs stay stopped).
```

---

## 3. What the bot tells you

### 3.1 Proposals: approve or reject from the chat

When a run reaches a gate (`gate.act` or `gate.review`), each new proposal arrives as its own message. If a run
produces more than 5 at once, you get a single message with a link to the inbox. Dry runs never notify.

```
Bot:  Storm · Application replies: approve email.send?
      Target: hr@example.com

      to: hr@example.com
      subject: Re: Senior Backend Engineer
      body:
      Hi Maria, thanks for getting back to me…
      [Approve] [Reject] [Open]
```

When you decide, whether here, in Storm or anywhere else, the message is edited to show the outcome and its buttons
are removed.

**Approve** appears, and works, only when all of these are true:
- the message shows the whole payload (not cut off for length),
- it is a `gate.act` proposal (for `gate.review` you pick items in Storm),
- the proposal is still waiting,
- the payload hasn't changed since the message was sent (the button carries its hash),
- nothing new is targeted (a new target must be approved in Storm).

If any of these fails, the button says why and you open the proposal in Storm instead. **Reject** always works on a
waiting `gate.act` proposal.

### 3.2 "Storm needs you": takeovers

A browser step that hits a CAPTCHA, a 2FA prompt, a failed sign-in or a missing element waits with the page open:

```
Bot:  Storm needs you: CAPTCHA at apply (jobs.example.com).
      [Open the live view]
```

Open the live view, solve it, then press Continue (or Abort) in Storm. If nobody responds within
`TAKEOVER_TIMEOUT_MINUTES`, the step fails.

### 3.3 Questions: reply to answer

When a form asks something that neither your profile nor your facts answer, the run asks you:

```
Bot:  Storm asks (a form on jobs.example.com): What is your notice period?
      Reply to this message with your answer. It's kept as a fact, so the next form won't ask again.
      [Answer on Storm]

You:  (reply to that message) 1 month
Bot:  Thanks: "What is your notice period?" is 1 month. Kept for the next forms; the run goes on.
```

It must be a Telegram **reply** to the question's message (swipe or long-press → Reply). A new message would go to
the builder instead. The answer is saved on the Profile page as a fact.

### 3.4 Scheduled messages

| Message | When (Europe/Sofia) | Contents | Switch |
| --- | --- | --- | --- |
| Morning brief | every day 07:30 | Today's calendar (if Google is connected), what waits for you, failures in the last day, unpaid bills due within 3 days | Settings |
| Daily digest | every day 19:00 | What ran, what waits, what failed, suggestions, LLM cost | the `Daily digest` pipeline ([pipelines/daily-digest.yaml](../pipelines/daily-digest.yaml)) |
| Weekly review | Sunday 19:00 | The 7-day digest, budget so far, where the money went, application outcomes, recipes that found nothing for a while | Settings |

### 3.5 Alerts

- **Worker down / back**: when the worker's heartbeat stops, and again when it returns (once per change).
- **Health reports**: a job on the host (backups, the restore test, …) that reports a failure or stops reporting, once,
  and again when it recovers.
- **LLM budget**: at 80% of the monthly budget, and when the budget is reached (non-essential pipelines then stop
  before their next LLM step). Includes an *Open Settings* button.
- **Broken recipe**: a recipe that no longer matches its page, with a button to the recipe.
- **Google Calendar needs reconnecting**: includes a *Reconnect* button. The waiting run continues once you sign in.

---

## 4. Building pipelines by chatting

Any message that isn't a command or a reply to a question goes to the **pipeline builder**, the same one as on the
Builder page. While it works you see "typing…", and then you get its answer with the proposed pipeline:

```
You:  Every morning at 9, check the Hacker News front page and tell me about anything mentioning Postgres.

Bot:  Here's a pipeline that reads the front page daily and messages you only when a story mentions Postgres.

      Proposal: Daily Postgres mentions on Hacker News
      HN Postgres watch, on the schedule 0 9 * * * (Europe/Sofia)
      1. page: http.fetch
      2. postgres: data.filter
      3. seen: data.save
      4. tell: notify.telegram

      (/new starts over)
      [Save] [Dry run]
      [Open in Storm]
```

Then:
- **Dry run** runs it without sending anything. Gates show only what would happen. You get a link to the run.
- **Save** saves it as a pipeline (or as the next version when editing). A scheduled or triggered pipeline is saved
  **off**, and the bot offers **Turn on**. A manual one is started with `/run`.
- Keep talking to refine it ("only weekdays", "also include MySQL"). The chat continues while you're active (2
  hours without a message, or the chat's token cap, starts a new one). `/new` starts over right away.

Editing an existing pipeline:

```
You:  /edit price watch
Bot:  Talking about Price watch v3: what should change?
You:  Also tell me when something becomes more expensive by more than 10%.
Bot:  … [Save as v4] [Dry run] [Open in Storm]
```

If the builder's last attempt didn't compile, the answer lists the errors. If it refuses (busy, no API key, cost
cap), the bot says so.

---

## 5. Sending your own messages from a pipeline: `notify.telegram`

Any pipeline can message you with the `notify.telegram` step. It sends only to your chat, and in a dry run the text
starts with `[Dry run]`. Use `{{…}}` to insert outputs from earlier steps, and `when:` to send only when there is
something to say.

### Example: tell you only when something changed

From [pipelines/price-watch.yaml](../pipelines/price-watch.yaml):

```yaml
name: Price watch
trigger: { schedule: "0 10 * * *", tz: Europe/Sofia }
steps:
  - id: list
    type: browser.extract
    with: { recipes: [shop.example/hdd], maxItems: 100 }
  - id: prices
    type: data.history
    with: { items: "{{list.items}}", collection: prices, key: url, value: price }
  - id: cheaper
    type: data.filter
    with:
      items: "{{prices.items}}"
      where: [{ field: history.direction, op: eq, value: down }]
  - id: lines
    type: llm.generate
    when: "{{cheaper.items}}"            # nothing cheaper → this step and the message are skipped
    with:
      instruction: One line per product: title, old price → new price, then its url.
      context: "{{cheaper.items}}"
  - id: tell
    type: notify.telegram
    with: { text: "Cheaper today:\n{{lines.text}}" }
```

### Example: a simple reminder

```yaml
name: Water the plants
trigger: { schedule: "0 18 * * 3,6", tz: Europe/Sofia }   # Wednesday and Saturday at 18:00
steps:
  - id: tell
    type: notify.telegram
    with: { text: "Water the plants 🌱" }
```

### Example: one message per item

From [pipelines/application-replies.yaml](../pipelines/application-replies.yaml). `forEach` sends one message per
item, and `when` limits it to items whose status changed:

```yaml
  - id: tell
    type: notify.telegram
    forEach: "{{triage.kept}}"
    when: "{{outcome.changed}}"
    with:
      text: "…"
```

### Example: the daily digest

```yaml
name: Daily digest
trigger: { schedule: "0 19 * * *", tz: Europe/Sofia }
steps:
  - id: digest
    type: notify.digest
    with: { hours: 24 }
```

Mark it **Essential** on its page so it keeps running after the LLM budget is spent (it doesn't use the LLM).

Other pipelines that use Telegram: [release-watch.yaml](../pipelines/release-watch.yaml),
[product-watch.yaml](../pipelines/product-watch.yaml), [bills.yaml](../pipelines/bills.yaml),
[follow-up.yaml](../pipelines/follow-up.yaml), [release-notes.yaml](../pipelines/release-notes.yaml).

---

## 6. Limits and what the bot won't do

- **Only you.** Messages from other users, groups or channels are ignored without a reply.
- **It doesn't act on its own from the chat.** Side effects still go through gates. Telegram can approve only
  complete, unchanged proposals whose targets you've approved before.
- **Message length:** Telegram's limit is 4096 characters. Longer proposals are cut off and must be decided in Storm.
  Longer builder answers are truncated.
- **No images, files or voice.** It handles text only.
- **Item picking (`gate.review`) is done in Storm**, not in the chat.
- **Late commands are dropped** (older than 5 minutes). Button presses and replies are still handled.

## 7. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing is ever sent | `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing |
| Notifications arrive, but the bot doesn't respond | The webhook isn't set up, or `TELEGRAM_WEBHOOK_SECRET` doesn't match the gateway (`forwarded: 404` in its log) |
| The gateway forwarded (`forwarded: 200`) but the bot is silent | `TELEGRAM_CHAT_ID` isn't your user id |
| No Approve button | The payload was too long, it's a `gate.review`, or *Approve on Telegram* is off |
| "It changed since this message" | The payload was edited after the message was sent: decide in Storm |
| A reply to a question went to the builder | It was a new message, not a Telegram *reply* to the question |
