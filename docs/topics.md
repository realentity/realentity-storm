# Topics: replies that know the subject

A reply about a project needs to know what is true about it: who is who, what was decided, what changed since. Storm's
drafts never invent facts, so without that knowledge a reply is polite and empty, with a placeholder where the answer
should be. A **topic** is where Storm keeps what it knows about one subject: a project, a customer, a house purchase.
That knowledge comes from your email and from the documents you point it to, and **nothing goes into it without your
approval**.

Most email needs no topic. Give one to the few subjects where your replies keep needing facts.

How it is built: [design.md §8.1](design.md#81-topics).

## Start in four steps

Everything below is on the **Topics** page.

1. **Make a topic and say which email belongs to it.** Give it a name and a line about what it is ("Orion: the
   customer portal rebuild for Client Ltd"). Then add **directions**:

   | Direction      | Matches                                                                       | Checked by     |
   | -------------- | ----------------------------------------------------------------------------- | -------------- |
   | A word         | `Orion` in the subject or the text, as a whole word                           | Storm, exactly |
   | A domain       | anyone writing from `client.example` or its subdomains                        | Storm, exactly |
   | A person       | `ivan@client.example`; with "about", only their emails about that ("the API") | Storm, exactly |
   | In plain words | "emails about the payment integration"                                        | the LLM        |

   An email can belong to no topic, to one, or to several. Without a direction, no email is linked.

2. **Keep topics up to date.** On the card of that name, press **Set up**. That installs _Topic upkeep_, an ordinary
   pipeline of yours, switched off. Try it with a dry run, which saves nothing, then switch it on. Every 15 minutes it
   does three things. It sorts your new and sent email into your topics, setting newsletters and notifications aside.
   It reads what changed in your topics' documents. And it proposes what they state that is worth remembering. It
   sends nothing.

3. **Approve the facts.** The proposals of each run wait in the **Inbox**, at that run's gate. Each one shows its
   source and its quote, and you pick the ones that go in. They then appear under **Facts** on the topic's card.

4. **Answer your topics' email.** On the card of that name, press **Set up**. That installs _Topic replies_, switched
   off like upkeep. Every 15 minutes it drafts a reply to each new email of a topic that expects one, using what the
   topic knows. Each draft waits in the Inbox for you to edit and **Act**. If you also use _Recruiter and client
   replies_, it leaves your topics' email to Topic replies, so no email gets two drafts.

Your existing drafting pipelines use topics too. `email.draftReply` and `email.draftFollowUp` take `topic: auto` by
default, so any email already linked to a topic gets the topic's knowledge.

## Which email belongs to a topic

- **A direction matches:** the email is linked. An email in a thread already linked to a topic is linked to it too.
- **Only the LLM thinks so** (a direction in plain words, or an email no exact direction matched): the email is
  _suggested_. It waits under **Waiting for you**: answer **Yes**, **No**, or move it to another topic. Each answer
  teaches the next check.
- **Nothing matches:** the email stays unlinked. That is normal, and it is answered as before, without a topic.

Storm keeps an email's ids, sender, subject and date for its links, never its text. When the text is needed, Storm
reads it from your mailbox again.

## Facts

A fact is a short statement, such as "Launch date: March". Each one has its source (an email, a document at a commit,
or you) and that source's date. A fact is _current_, _superseded_ by a newer one (kept in the history), or _in
dispute_ when sources disagree.

- **New evidence proposes changes.** A new fact ("Launch date: March"), a change ("~~February~~ → March", the old one
  kept as history), or a conflict ("the decision record says PostgreSQL; Ivan's email of 14 Nov says MySQL"). Evidence
  counts by its date, not by when it was read, so an old email read late never undoes a newer fact.
- **You correct any fact on the topic's card:**

  | Action             | Meaning                      | What follows                                                  |
  | ------------------ | ---------------------------- | ------------------------------------------------------------- |
  | Edit               | the wording or value was off | the fact is now yours and pinned                              |
  | No longer true     | it was, things changed       | superseded, kept in the history; you can say what is true now |
  | Wrong              | it never was                 | removed, and not proposed again from the same source          |
  | Move to            | it belongs to another topic  | moved with its source                                         |
  | Holds (in dispute) | this one is right            | current and pinned; the others superseded                     |

- **Facts you wrote, edited or confirmed are pinned.** Later evidence can only put a pinned fact in dispute, never
  replace it.
- **Every change can be undone.** Open **History** to see each change, and press **Undo** on one, as long as no later
  change builds on it.
- **Anything that looks like a secret** (a password, a key, a token) is never proposed as a fact, and you can't save
  one either.

## Documents

A topic can point to where its documents live. Storm links them and never keeps a copy you would have to maintain.

- **A GitHub repository.** Add it under **Sources** with a path pattern (`docs/adr/**`) and, optionally, a branch.
  Storm reads text files only (Markdown, text, AsciiDoc and similar). Storm checks the branch's latest commit every
  upkeep run, and reads only the files that changed.

  A private repository needs a token, not your GitHub password. **New GitHub token** in the source form (or kind
  *GitHub token* on **Credentials**) shows the steps and keeps it for `api.github.com` only:
  a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with the
  repositories' owner as its resource owner, only the repositories you pick, and **Contents: Read-only**. One token
  covers the repositories of one owner; repositories of another owner (a client's organization) need a token of their
  own, which that organization may have to approve. A topic can have several sources, each with its own token.
- **A Google Drive folder.** Add it under **Sources → Google Drive folder** by its link (open the folder in Drive and
  copy the address). Storm reads it with its subfolders: Google Docs (as Markdown, so their headings split the
  passages), Slides, PDFs and text files; **Files** narrows it (`Specs/**`, `**/*.pdf`). It is read through your Google
  connection, which must allow Drive (read-only): Settings shows whether it does, and [google-setup.md](google-setup.md)
  says how. Every upkeep run asks Drive what changed in your Drive since the last one, which is one call when nothing
  did, and reads only the files that changed under the folder. A file deleted, binned or moved out of the folder loses
  its passages; a renamed or moved one keeps its place by its id. A folder moved into the source's folder is read at
  the next **Rebuild**. A draft cites a Drive file by its path and folder, such as `Specs/API, in the Drive folder Orion`.
- **Email attachments.** PDFs and text files attached to a topic's email are added by themselves.

Documents are split into passages at their headings and kept in an index, so a draft can quote the passage closest to
the email it answers. The draft cites the passage's file and commit, such as `docs/adr/0012-database.md @ a1b2c3d`. A
changed document also proposes facts, like an email. The index is only a cache: **Rebuild** clears a source's passages, and the next upkeep run reads them again.

## A topic's history

A new topic knows nothing of the email from before you made it. **Its history** on the topic's card reads past email
and the topic's documents for facts:

1. **Estimate:** choose how far back to go. Storm counts the emails and documents and estimates the cost. No LLM reads
   anything yet.
2. **Start:** the reading goes through the Batch API, at half the price, and is usually done within a day.
3. **Pick:** the proposals wait on the card, oldest first, and only the ones you keep are written.

## How a draft uses a topic

- **Which topics:** with `topic: auto`, the email's linked or confirmed topics; for your own email, as in a follow-up,
  its thread's. A suggestion still waiting for you doesn't count. `topic: none` uses no topic, and `topic: Orion` uses
  that one whatever the email.
- **What it gets:** the topic's line about what it is, its current facts, and up to four passages of its documents,
  the closest to the email. It must never contradict a fact, and what none of them says stays a placeholder.
- **When there are too many facts:** a draft has room for about 6,000 characters of them. While they fit, all go in.
  When they don't, the ones you wrote or confirmed go first, then the ones closest to the email: by meaning, in any
  language, if `OPENAI_API_KEY` is set, otherwise by the words they share. The topic's card tells you when not all
  fit. Saying which facts are no longer true, or splitting the topic, keeps more of them in every draft.
- **Why:** the draft lists what it relied on, and the gate shows it under **Why**, each fact with its source. You see
  stale or wrong knowledge where it matters, before anything is sent.

## It learns from you

Suggestions wait under **Suggested** on the Topics page. Nothing is active before you press **Yes**, and a **No** isn't
asked again.

- **Directions.** "Add the person `ivan@client.example` to Billing?" comes when you have confirmed or moved enough of
  someone's emails into a topic. It is counted from your decisions, without the LLM, and never suggests a free mail
  domain.
- **New topics.** The nightly review looks at the triaged emails no topic took. When several of them, over several days
  and from several people, are about one subject, it suggests a topic with its directions. For this, Storm keeps those
  emails' sender, subject and date for 30 days, never their text.
- **Facts from your edits.** When you add or correct a statement in a draft ("per ADR-0012 we use PostgreSQL"), the
  nightly review suggests it as a fact for the email's topic. Accepted, it is yours and pinned. A change of style
  becomes a rule suggestion instead, as for any draft.

## Split and merge

- **Split** a topic that has grown into two subjects: name the new topic and tick the facts, directions, sources and
  emails that go to it.
- **Merge into** another topic when two topics are one subject. A fact both say the same about is kept as history; one
  they disagree on is put in dispute for you to settle. The merged topic is archived.

Both are one change in the History, and **Undo** puts everything back.

## What it costs and what goes where

- **Costs.** Matching by exact directions costs nothing. The cheap model checks only the triaged email no direction
  matched, and screens what is worth reading before the writing model proposes facts. Each topic's card shows what it
  cost in the last 30 days, and the weekly review lists the topics' costs. The topic pipelines pause when the month's
  LLM budget is reached.
- **To the LLM (Anthropic):** the text of the emails and documents being matched, read for facts or answered, as for
  any pipeline. Email and document text is always passed as data: it can lead to a proposal, never write a fact or a
  direction.
- **To OpenAI, only if `OPENAI_API_KEY` is set:** the passages of your topics' documents, your facts, and the start of
  an email being answered, for their embeddings. Without the key, everything works by words.
- **Kept in Storm's database:** your topics, directions and facts; the passages of your topics' documents (the index);
  and the ids, sender, subject and date of linked emails. Never the text of an email.

## Not built yet

- A topic's people, with the role you give them.
- A periodic tidy-up proposing to merge overlapping facts and retire stale ones.
