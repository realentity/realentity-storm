# Local models

Storm's LLM steps can run on a model on your own hardware instead of Claude: on
[Ollama](https://ollama.com), a llama.cpp server, vLLM, LM Studio, or any other server with an OpenAI-compatible
API. The email text, pages and documents those steps read then stay on your machine, and the model costs nothing per
call.

**It is off by default.** `OPENAI_BASE_URL` in `.env` only makes a server available; you switch local models on and
off in **Settings**, whenever you like, without a restart. While they are off, every task uses Claude, as before. On,
you choose one model for all tasks or a model per task, and you can mix the two: a local model for email triage and
scoring, Claude for the builder.

- [Switch them on](#switch-them-on)
- [Switch them off](#switch-them-off)
- [Which model](#which-model): what we measured
- [What is different](#what-is-different) from Claude
- [Measure your own](#measure-your-own): `pnpm llm:check`
- [Troubleshooting](#troubleshooting)

## Switch them on

These steps use Ollama; another server works the same way with its own address.

1. **Install Ollama** and pull a model, e.g. `ollama pull qwen3:14b` ([which model](#which-model)).

2. **Raise Ollama's context.** Ollama gives a model 4,096 tokens of context by default and cuts longer prompts
   silently, which makes a model look worse than it is. Set `OLLAMA_CONTEXT_LENGTH=16384` in Ollama's environment
   (in its Settings on Windows and macOS, in its service on Linux) and restart it.

3. **Let Storm's containers reach it.** Ollama listens on `127.0.0.1` only, and inside a container that is the
   container itself. Either set `OLLAMA_HOST=0.0.0.0` for Ollama and keep port 11434 closed to everything but the
   Docker networks in your firewall, or run Ollama on another machine of your private network. Storm's containers
   reach the host as `host.docker.internal`.

4. **Tell Storm where it is** in `.env`, and apply it with `./docker/storm up` (with `STORM_LOCAL=1` if you use the
   bundled database):

   ```
   OPENAI_BASE_URL=http://host.docker.internal:11434/v1
   ```

   This is the server, up to its `/v1`. It makes local models available; it doesn't switch them on.

5. **Switch them on** in **Settings → AI → Local models**. Then:

   - **Model for all tasks**: the local model of every task without its own choice, e.g. `openai:qwen3:14b`.
   - **Per task**: each step type's menu lists the server's models next to Claude's. A task's own choice comes first.
   - The models are named `openai:<name>`, by their name on the server (`ollama list`). Names without `openai:` are
     Claude.

   If the server doesn't answer, Settings says why, and the rest of the page still works.

**From `.env` instead of Settings**: `LLM_MODEL=openai:qwen3:14b` is the model for all tasks while local models are on
and Settings doesn't choose one. `LLM_MODEL_CLASSIFY`, `LLM_MODEL_WRITING`, `LLM_MODEL_REFLECTION` and
`LLM_MODEL_BUILDER` set one group each and take both kinds, e.g. `LLM_MODEL_BUILDER=claude-opus-5-5` keeps the builder
on Claude while the rest is local. Without `ANTHROPIC_API_KEY`, Storm runs on local models alone.

## Switch them off

**Settings → AI → Local models** off. From the next step on, every task uses Claude: its Claude choice in Settings, else
`.env`, else the defaults. The local models you chose stay where they are, marked "… once local models are on", and
are used again when you switch back on.

Local models are off too while `OPENAI_BASE_URL` is empty: then Settings can't switch them on, and no model call goes
to any OpenAI-compatible server. An `OPENAI_API_KEY` alone (for embeddings) never sends a model's calls to OpenAI.

## Which model

Measured on 25 November 2026 with `pnpm llm:check` ([below](#measure-your-own)): eleven checks that run Storm's real
steps on made-up data. Ollama 0.40.18, its default quantisation, a 16K context. One run per check so far: the times
are a guide, a single pass not a guarantee.

**On a GPU** (AMD Radeon RX 6900 XT, 16 GB, through Vulkan, power limit lowered by about 10%):

| Check | What it asks | qwen3:8b | qwen3:14b | gemma3:12b | mistral-small3.2:24b |
|---|---|---|---|---|---|
| `llm.classify` | 8 items into labels | ✓ 8/8 | ✓ 8/8 | ✓ 8/8 | ✓ 8/8 |
| `llm.score` | 4 postings in the right order | ✓ 11 s | ✓ 12 s | ✓ 4 s | ✓ 12 s |
| `llm.extract` | an invoice's fields | ✓ 25 s | ✓ 14 s | ✓ 3 s | ✓ 9 s |
| `llm.extract` (scan) | a warranty card from an image | text only | text only | ✓ 10 s | ✓ 9 s |
| `llm.summarize` | 40 words, keeping the decision | ✓ 5 s | ✓ 7 s | ✓ | ✓ 3 s |
| `llm.generate` | a plain-text note | ✓ 4 s | ✓ 9 s | ✓ 1 s | ✓ 4 s |
| `email.classify` | 12 emails: reply or skip | ✓ 12/12 | ✓ 12/12 | ✓ 12/12 | ✓ 12/12 |
| `email.draftReply` | answer from agreed facts, nothing made up | ✓ 5 s | ✓ 7 s | ✓ 2 s | ✗ language "english", not "en" |
| `email.draftReply` (bg) | a Bulgarian email, in Bulgarian | ✓ | ✓ 7 s | ✓ 2 s | ✓ 4 s |
| `topic.extract` | a changed fact, as a change of the known one | ✓ 10 s | ✓ 14 s | ✓ 4 s | ✓ 11 s |
| tools | tool calls (the builder, `browser.agent`) | ✓ 8 s | ✓ 4 s | no tool calls | ✓ after one correction |
| **All eleven** | | **~2 min** | **~2¼ min** | **~1 min** | **~2½ min** |
| Size | | 5.2 GB | 9.3 GB | 8.2 GB | 15 GB |

**On a CPU only** (a 32-thread desktop CPU, the same qwen3:8b with the GPU off): the same results, 10 of 11, about
five times slower: **~10 minutes** for all eleven, a single step 20 seconds to 3 minutes. The CPU stayed around half
used.

| Check | GPU | CPU only |
|---|---|---|
| `llm.score` | 11 s | 87 s |
| `llm.extract` | 25 s | 174 s |
| `email.classify` (12 emails) | 12 s | 80 s |
| `email.draftReply` | 5 s | 27 s |
| `topic.extract` | 10 s | 73 s |
| tools | 8 s | 28 s |

**What we'd choose:**

| For | Model |
|---|---|
| Everything but scans, the builder included | **qwen3:14b** (a GPU with 12 GB or more) |
| Everything, scans included, one model | **mistral-small3.2:24b** (a GPU with 16 GB or more) |
| Scans and fast text work, no builder or `browser.agent` | **gemma3:12b**: it has no tool calls |
| No GPU | **qwen3:8b**, for pipelines that run on a schedule (triage, Papers, scoring). Too slow for the builder chat |

A CPU with fewer cores is slower in proportion: half the threads, about twice the time.

## What is different

- **Cost:** local models count as $0 in the budget and on the dashboard. Claude's tasks still cost what they cost.
- **Effort** isn't sent (Settings shows "—"): a local model thinks as much as it does by itself. qwen3 thinks before every answer, which is
  most of its time.
- **No prompt caching** and no batch API: the nightly reflection and a topic's backfill send their requests one by
  one, two at a time, inside the worker. A batch still running when the worker restarts is lost ("The batch is
  gone") and has to run again.
- **Answers are checked the same way.** Every answer must match the step's schema; a local model that answers off
  the schema is told what was wrong and gets one more try, then the step fails with the reason.
- **Images** (Papers' scans, screenshots for `browser.agent`) need a model that can see them: gemma3, mistral-small3.2,
  qwen2.5vl. A text-only model fails such a step with the server's message.
- **PDFs** aren't sent to local models: a step that would give the model a PDF fails and says so. Choose a Claude
  model for that step type, or a pipeline that reads the PDF's text first (`file.read`, `bill.read` already do).
- **Tool calls** are what the builder and `browser.agent` work with. A model without them (gemma3) can't do those.
- **Embeddings** (examples in drafts, topics by meaning) still come from OpenAI itself when `OPENAI_API_KEY` is set:
  that text goes to OpenAI even with every model local. Leave the key empty to keep it home; drafts are then written
  without examples, and topics match by words.
- **`OPENAI_API_KEY` is sent to `OPENAI_BASE_URL`** as its key. Ollama ignores it; point `OPENAI_BASE_URL` only at
  servers you trust with that key.

## Measure your own

`pnpm llm:check` runs the eleven checks above against any model: a local one, or Claude to compare. It needs a
checkout of the repository with `pnpm install`, not the containers.

```bash
pnpm --filter @realentity/storm-worker llm:check --model openai:qwen3:14b --base-url http://localhost:11434/v1
pnpm --filter @realentity/storm-worker llm:check --model openai:gemma3:12b --runs 1 --only llm.extract,tools
pnpm --filter @realentity/storm-worker llm:check --model claude-haiku-5-5        # needs ANTHROPIC_API_KEY
```

- `--runs` (default 3): how often each check runs; the table says how many passed and the median time.
- `--only`: some checks, by the names in the table above.
- Results go to `apps/worker/evals/results/<date>-llm-check-<model>.json`, saved after every check, so a run cut
  short keeps what it measured.
- The data is made up, and nothing is sent anywhere but to the model. The first check includes loading the model.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| Settings: "The models on host.docker.internal:11434 couldn't be listed: The model server (…) could not be reached" | The containers can't reach the server: see step 3 above (`OLLAMA_HOST`, the firewall) |
| "… refused the request (404: model … not found)" | The name after `openai:` isn't on the server: `ollama list`, or `ollama pull` it |
| "… does not support tools" | That model has no tool calls: choose another one for the builder and `browser.agent` |
| "Multimodal data provided, but model does not support multimodal requests" | A step sent an image to a text-only model: choose a model that sees images for that step type |
| Answers that ignore half of a long email | The context is cut: raise `OLLAMA_CONTEXT_LENGTH` (step 2) |
| The first call of a step takes a minute | The model is loading into memory; Ollama unloads it after 5 idle minutes (`OLLAMA_KEEP_ALIVE`) |
| "The model server (…) didn't answer in time" | Storm waits 10 minutes for an answer: the model is too large for the hardware; choose a smaller one |
| "The model's answer did not match the expected format" | It answered off the schema twice: a larger model, or Claude for that step type |
