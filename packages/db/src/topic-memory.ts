import {
  type Prisma,
  type PrismaClient,
  type TopicChangeKind,
  type TopicFact,
  type TopicFactSource,
  type TopicFactStatus,
  type TopicLinkStatus,
  type TopicLinkVia,
  type TopicStatus,
} from "./generated/prisma/client";

/**
 * A topic's facts and their changes (M42-T1, docs/design.md §8.1). Every change, the user's or an approved proposal's,
 * goes through here: it records each fact before and after, so it can be undone, and says why in one line. Used by the
 * api (the user's changes) and the worker (topic.apply).
 */

export class TopicMemoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** A fact as a change records it: everything that a change or its undo can touch. */
export interface FactSnapshot {
  topicId: string;
  about: string;
  statement: string;
  source: TopicFactSource;
  sourceId: string | null;
  sourceLabel: string;
  sourceDate: string;
  quote: string;
  status: TopicFactStatus;
  supersededById: string | null;
  pinned: boolean;
  runId: string | null;
}

interface FactEntry {
  topicFactId: string;
  before: FactSnapshot | null;
  after: FactSnapshot | null;
}

/** A row that a split or merge moved to another topic (or, `topic`, a topic's status it changed). */
interface MoveEntry {
  table: "direction" | "source" | "link" | "topic";
  id: string;
  from: string;
  to: string;
}

interface LinkEntry {
  topicLinkId: string;
  before: { status: TopicLinkStatus; via: TopicLinkVia; evidence: string } | null;
}

type Tx = Prisma.TransactionClient;

/** What a change does, through these, so each fact's before and after is recorded. */
class Recorder {
  readonly facts: FactEntry[] = [];
  readonly links: LinkEntry[] = [];
  readonly moves: MoveEntry[] = [];

  constructor(readonly tx: Tx) {}

  async create(data: Omit<Prisma.TopicFactUncheckedCreateInput, "topicFactId">): Promise<TopicFact> {
    const fact = await this.tx.topicFact.create({ data });
    this.facts.push({ topicFactId: fact.topicFactId, before: null, after: snapshot(fact) });
    return fact;
  }

  async update(fact: TopicFact, data: Prisma.TopicFactUncheckedUpdateInput): Promise<TopicFact> {
    const updated = await this.tx.topicFact.update({ where: { topicFactId: fact.topicFactId }, data });
    this.facts.push({ topicFactId: fact.topicFactId, before: snapshot(fact), after: snapshot(updated) });
    return updated;
  }

  link(topicLinkId: string, before: LinkEntry["before"]): void {
    this.links.push({ topicLinkId, before });
  }

  /** Moves a direction, a source (with its passages) or an email's link to another topic. */
  async move(table: "direction" | "source" | "link", id: string, from: string, to: string): Promise<void> {
    await moveRow(this.tx, table, id, to);
    this.moves.push({ table, id, from, to });
  }

  async topicStatus(topicId: string, from: TopicStatus, to: TopicStatus): Promise<void> {
    await this.tx.topic.update({ where: { topicId }, data: { status: to } });
    this.moves.push({ table: "topic", id: topicId, from, to });
  }
}

interface ChangeMeta {
  userId: string;
  topicId: string;
  otherTopicId?: string;
  kind: TopicChangeKind;
  summary: string;
  runId?: string;
}

async function change<T>(prisma: PrismaClient, meta: ChangeMeta, work: (r: Recorder) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const recorder = new Recorder(tx);
    const result = await work(recorder);
    await recordChange(tx, meta, recorder);
    return result;
  });
}

async function recordChange(tx: Tx, meta: ChangeMeta, recorder: Recorder): Promise<void> {
  await tx.topicChange.create({
    data: {
      userId: meta.userId,
      topicId: meta.topicId,
      otherTopicId: meta.otherTopicId ?? null,
      kind: meta.kind,
      summary: meta.summary.slice(0, 500),
      facts: recorder.facts as unknown as Prisma.InputJsonValue,
      links: recorder.links as unknown as Prisma.InputJsonValue,
      moves: recorder.moves as unknown as Prisma.InputJsonValue,
      runId: meta.runId ?? null,
    },
  });
}

export function snapshot(fact: TopicFact): FactSnapshot {
  return {
    topicId: fact.topicId,
    about: fact.about,
    statement: fact.statement,
    source: fact.source,
    sourceId: fact.sourceId,
    sourceLabel: fact.sourceLabel,
    sourceDate: fact.sourceDate.toISOString(),
    quote: fact.quote,
    status: fact.status,
    supersededById: fact.supersededById,
    pinned: fact.pinned,
    runId: fact.runId,
  };
}

function fromSnapshot(s: FactSnapshot): Omit<Prisma.TopicFactUncheckedCreateInput, "topicFactId" | "userId"> {
  return { ...s, sourceDate: new Date(s.sourceDate) };
}

/** "Launch date: March". */
export function factLine(fact: { about: string; statement: string }): string {
  return `${fact.about}: ${fact.statement}`;
}

/** Same thing the fact is about, in any case and spacing. */
export function sameAbout(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return norm(a) === norm(b);
}

async function ownTopic(tx: Tx | PrismaClient, userId: string, topicId: string): Promise<void> {
  const topic = await tx.topic.findFirst({ where: { topicId, userId }, select: { topicId: true } });
  if (!topic) throw new TopicMemoryError("not_found", "No such topic");
}

async function ownFact(prisma: PrismaClient, userId: string, topicFactId: string): Promise<TopicFact> {
  const fact = await prisma.topicFact.findFirst({ where: { topicFactId, userId, status: { not: "WRONG" } } });
  if (!fact) throw new TopicMemoryError("not_found", "No such fact");
  return fact;
}

/** The user writes a fact: its source is them, it is pinned. */
export async function addFact(
  prisma: PrismaClient,
  userId: string,
  topicId: string,
  fact: { about: string; statement: string },
): Promise<TopicFact> {
  await ownTopic(prisma, userId, topicId);
  return change(prisma, { userId, topicId, kind: "ADD", summary: `Added "${factLine(fact)}"` }, (r) =>
    r.create({
      userId,
      topicId,
      about: fact.about,
      statement: fact.statement,
      source: "USER",
      sourceLabel: "you",
      sourceDate: new Date(),
      pinned: true,
    }),
  );
}

/** Edit: the wording or value was off. The fact keeps its source and is pinned. */
export async function editFact(
  prisma: PrismaClient,
  userId: string,
  topicFactId: string,
  edit: { about: string; statement: string },
): Promise<TopicFact> {
  const fact = await ownFact(prisma, userId, topicFactId);
  const summary =
    fact.statement === edit.statement
      ? `Edited "${fact.about}" → "${edit.about}"`
      : `Edited "${fact.about}": ${fact.statement} → ${edit.statement}`;
  return change(prisma, { userId, topicId: fact.topicId, kind: "EDIT", summary }, (r) =>
    r.update(fact, { about: edit.about, statement: edit.statement, pinned: true }),
  );
}

/** No longer true: it was, things changed. Superseded and kept in the history; with what is true now, by that. */
export async function noLongerTrue(prisma: PrismaClient, userId: string, topicFactId: string, now?: string): Promise<TopicFact> {
  const fact = await ownFact(prisma, userId, topicFactId);
  if (fact.status === "SUPERSEDED") throw new TopicMemoryError("conflict", "It is no longer current already");
  const summary = now ? `${fact.about}: ${fact.statement} → ${now}` : `No longer true: "${factLine(fact)}"`;
  return change(prisma, { userId, topicId: fact.topicId, kind: "NO_LONGER_TRUE", summary }, async (r) => {
    const replacement = now
      ? await r.create({
          userId,
          topicId: fact.topicId,
          about: fact.about,
          statement: now,
          source: "USER",
          sourceLabel: "you",
          sourceDate: new Date(),
          pinned: true,
        })
      : null;
    await r.update(fact, { status: "SUPERSEDED", supersededById: replacement?.topicFactId ?? null });
    return replacement ?? fact;
  });
}

/**
 * Wrong: it never was. Hidden (status WRONG), so its source doesn't propose it again; the facts it had superseded are
 * current again.
 */
export async function markWrong(prisma: PrismaClient, userId: string, topicFactId: string): Promise<void> {
  const fact = await ownFact(prisma, userId, topicFactId);
  await change(prisma, { userId, topicId: fact.topicId, kind: "WRONG", summary: `Wrong: "${factLine(fact)}"` }, async (r) => {
    const older = await r.tx.topicFact.findMany({ where: { supersededById: topicFactId, status: "SUPERSEDED" } });
    await r.update(fact, { status: "WRONG", supersededById: null });
    for (const old of older) {
      if (fact.status === "CURRENT") await r.update(old, { status: "CURRENT", supersededById: null });
    }
  });
}

/** This one holds: current and pinned; the others in dispute about the same thing are superseded by it. */
export async function settleFact(prisma: PrismaClient, userId: string, topicFactId: string): Promise<TopicFact> {
  const fact = await ownFact(prisma, userId, topicFactId);
  const disputed = await prisma.topicFact.findMany({
    where: { topicId: fact.topicId, status: "DISPUTED", topicFactId: { not: topicFactId } },
  });
  const others = disputed.filter((d) => sameAbout(d.about, fact.about));
  return change(prisma, { userId, topicId: fact.topicId, kind: "SETTLE", summary: `Holds: "${factLine(fact)}"` }, async (r) => {
    for (const other of others) await r.update(other, { status: "SUPERSEDED", supersededById: topicFactId });
    return r.update(fact, { status: "CURRENT", supersededById: null, pinned: true });
  });
}

/**
 * Move: it belongs to another topic. It keeps its source; the email it came from is linked to that topic (confirmed),
 * so recognition learns the email concerns it too.
 */
export async function moveFact(prisma: PrismaClient, userId: string, topicFactId: string, topicId: string): Promise<TopicFact> {
  const fact = await ownFact(prisma, userId, topicFactId);
  if (fact.topicId === topicId) throw new TopicMemoryError("invalid", "It is in this topic already");
  const target = await prisma.topic.findFirst({ where: { topicId, userId } });
  if (!target) throw new TopicMemoryError("not_found", "No such topic");
  return change(
    prisma,
    { userId, topicId: fact.topicId, otherTopicId: topicId, kind: "MOVE", summary: `Moved "${factLine(fact)}" to ${target.name}` },
    async (r) => {
      if (fact.source === "EMAIL" && fact.sourceId) await linkEmail(r, userId, fact.topicId, topicId, fact.sourceId);
      return r.update(fact, { topicId, supersededById: null });
    },
  );
}

async function linkEmail(r: Recorder, userId: string, fromTopicId: string, topicId: string, messageId: string): Promise<void> {
  const existing = await r.tx.topicLink.findUnique({ where: { topicId_messageId: { topicId, messageId } } });
  if (existing) {
    if (existing.status === "CONFIRMED") return;
    r.link(existing.topicLinkId, { status: existing.status, via: existing.via, evidence: existing.evidence });
    await r.tx.topicLink.update({
      where: { topicLinkId: existing.topicLinkId },
      data: { status: "CONFIRMED", via: "USER", evidence: "a fact from it was moved here by you" },
    });
    return;
  }
  const origin =
    (await r.tx.topicLink.findFirst({ where: { userId, messageId, topicId: fromTopicId } })) ??
    (await r.tx.topicLink.findFirst({ where: { userId, messageId } }));
  if (!origin) return;
  const created = await r.tx.topicLink.create({
    data: {
      userId,
      topicId,
      messageId,
      threadId: origin.threadId,
      from: origin.from,
      subject: origin.subject,
      date: origin.date,
      status: "CONFIRMED",
      via: "USER",
      evidence: "a fact from it was moved here by you",
    },
  });
  r.link(created.topicLinkId, null);
}

/**
 * Undo a change: each fact (and email link) back to how it was before it. Only while they are as the change left them:
 * a later change to the same fact is undone first.
 */
export async function undoChange(prisma: PrismaClient, userId: string, topicChangeId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const found = await tx.topicChange.findFirst({ where: { topicChangeId, userId } });
    if (!found) throw new TopicMemoryError("not_found", "No such change");
    if (found.undoneAt) throw new TopicMemoryError("conflict", "It is undone already");
    const facts = found.facts as unknown as FactEntry[];
    const links = found.links as unknown as LinkEntry[];
    const moves = found.moves as unknown as MoveEntry[];
    for (const move of moves) {
      if (!(await isAt(tx, move))) throw new TopicMemoryError("conflict", "Something it moved has changed since: undo that first");
    }

    // Each fact's state now is what the change's last touch of it left.
    const last = new Map<string, FactEntry>();
    for (const entry of facts) last.set(entry.topicFactId, entry);
    const first = new Map<string, FactEntry>();
    for (const entry of [...facts].reverse()) first.set(entry.topicFactId, entry);
    for (const [topicFactId, entry] of last) {
      const now = await tx.topicFact.findUnique({ where: { topicFactId } });
      if (!same(now ? snapshot(now) : null, entry.after)) {
        throw new TopicMemoryError("conflict", "A fact it touched changed since: undo the later change first");
      }
    }
    for (const [topicFactId, entry] of first) {
      const before = entry.before;
      if (before && !(await tx.topic.findFirst({ where: { topicId: before.topicId, userId } }))) {
        throw new TopicMemoryError("conflict", "A topic it touched was deleted");
      }
      // A fact the change made goes again: not while a later fact points at it.
      const pointing = before ? [] : await tx.topicFact.findMany({ where: { supersededById: topicFactId }, select: { topicFactId: true } });
      if (pointing.some((p) => !last.has(p.topicFactId))) {
        throw new TopicMemoryError("conflict", "A later change builds on it: undo that first");
      }
    }

    // Restored in reverse: a fact made by the change is deleted after the ones pointing at it are restored.
    const restored = new Set<string>();
    for (const entry of [...facts].reverse()) {
      if (restored.has(entry.topicFactId)) continue;
      restored.add(entry.topicFactId);
      const before = first.get(entry.topicFactId)!.before;
      if (!before) await tx.topicFact.delete({ where: { topicFactId: entry.topicFactId } });
      else
        await tx.topicFact.upsert({
          where: { topicFactId: entry.topicFactId },
          create: { topicFactId: entry.topicFactId, userId, ...fromSnapshot(before) },
          update: fromSnapshot(before),
        });
    }
    for (const link of [...links].reverse()) {
      const exists = await tx.topicLink.findUnique({ where: { topicLinkId: link.topicLinkId } });
      if (!exists) continue;
      if (link.before) await tx.topicLink.update({ where: { topicLinkId: link.topicLinkId }, data: link.before });
      else await tx.topicLink.delete({ where: { topicLinkId: link.topicLinkId } });
    }
    for (const move of [...moves].reverse()) {
      if (move.table === "topic") await tx.topic.update({ where: { topicId: move.id }, data: { status: move.from as TopicStatus } });
      else await moveRow(tx, move.table, move.id, move.from);
    }
    await tx.topicChange.update({ where: { topicChangeId }, data: { undoneAt: new Date() } });
    // A split undone: the topic it made goes, if nothing else is in it now.
    if (found.kind === "SPLIT" && found.otherTopicId) {
      const made = await tx.topic.findUnique({
        where: { topicId: found.otherTopicId },
        include: { _count: { select: { facts: true, links: true, sources: true, directions: true } } },
      });
      if (made && Object.values(made._count).every((n) => n === 0)) await tx.topic.delete({ where: { topicId: made.topicId } });
    }
  });
}

async function moveRow(tx: Tx, table: "direction" | "source" | "link", id: string, topicId: string): Promise<void> {
  if (table === "direction") await tx.topicDirection.update({ where: { topicDirectionId: id }, data: { topicId } });
  else if (table === "link") await tx.topicLink.update({ where: { topicLinkId: id }, data: { topicId } });
  else {
    await tx.topicSource.update({ where: { topicSourceId: id }, data: { topicId } });
    await tx.topicPassage.updateMany({ where: { topicSourceId: id }, data: { topicId } });
  }
}

/** Whether a moved row is still where the move left it. */
async function isAt(tx: Tx, move: MoveEntry): Promise<boolean> {
  switch (move.table) {
    case "direction":
      return (await tx.topicDirection.count({ where: { topicDirectionId: move.id, topicId: move.to } })) === 1;
    case "source":
      return (await tx.topicSource.count({ where: { topicSourceId: move.id, topicId: move.to } })) === 1;
    case "link":
      return (await tx.topicLink.count({ where: { topicLinkId: move.id, topicId: move.to } })) === 1;
    case "topic":
      return (await tx.topic.count({ where: { topicId: move.id, status: move.to as TopicStatus } })) === 1;
  }
}

/**
 * Split (M44-T4, docs/design.md §8.1): the chosen facts, directions, sources and emails of a topic move to a new one.
 * One change: undone, they go back and the new topic goes if nothing else is in it.
 */
export async function splitTopic(
  prisma: PrismaClient,
  userId: string,
  topicId: string,
  request: { name: string; description: string; facts: string[]; directions: string[]; sources: string[]; links: string[] },
): Promise<{ topicId: string }> {
  const topic = await prisma.topic.findFirst({ where: { topicId, userId } });
  if (!topic) throw new TopicMemoryError("not_found", "No such topic");
  if (await prisma.topic.findUnique({ where: { userId_name: { userId, name: request.name } } })) {
    throw new TopicMemoryError("conflict", `There is a topic "${request.name}" already`);
  }
  const moving = request.facts.length + request.directions.length + request.sources.length + request.links.length;
  if (moving === 0) throw new TopicMemoryError("invalid", "Choose what moves to the new topic");
  const meta: ChangeMeta = { userId, topicId, kind: "SPLIT", summary: `Split into ${request.name}: ${moving} moved` };
  return change(prisma, meta, async (r) => {
    const made = await r.tx.topic.create({ data: { userId, name: request.name, description: request.description } });
    meta.otherTopicId = made.topicId;
    const facts = await r.tx.topicFact.findMany({ where: { topicFactId: { in: request.facts }, topicId, status: { not: "WRONG" } } });
    for (const fact of facts) await r.update(fact, { topicId: made.topicId });
    for (const d of await r.tx.topicDirection.findMany({ where: { topicDirectionId: { in: request.directions }, topicId } })) {
      await r.move("direction", d.topicDirectionId, topicId, made.topicId);
    }
    for (const s of await r.tx.topicSource.findMany({ where: { topicSourceId: { in: request.sources }, topicId } })) {
      await r.move("source", s.topicSourceId, topicId, made.topicId);
    }
    for (const l of await r.tx.topicLink.findMany({ where: { topicLinkId: { in: request.links }, topicId } })) {
      await r.move("link", l.topicLinkId, topicId, made.topicId);
    }
    return { topicId: made.topicId };
  });
}

/**
 * Merge (M44-T4): everything of `fromId` moves into `intoId`. Facts about the same thing that say something else are
 * put in dispute, for the user to settle; ones that say the same are kept as history. A direction, source or email the
 * other topic has already stays where it was; the merged topic is archived. One change: undone, all of it goes back.
 */
export async function mergeTopics(prisma: PrismaClient, userId: string, fromId: string, intoId: string): Promise<{ disputed: number }> {
  if (fromId === intoId) throw new TopicMemoryError("invalid", "A topic can't be merged into itself");
  const [from, into] = await Promise.all([
    prisma.topic.findFirst({ where: { topicId: fromId, userId }, include: { directions: true, sources: true } }),
    prisma.topic.findFirst({ where: { topicId: intoId, userId }, include: { directions: true, sources: true } }),
  ]);
  if (!from || !into) throw new TopicMemoryError("not_found", "No such topic");
  const meta: ChangeMeta = { userId, topicId: intoId, otherTopicId: fromId, kind: "MERGE", summary: "" };
  return change(prisma, meta, async (r) => {
    const live = { in: ["CURRENT", "DISPUTED"] as TopicFactStatus[] };
    const theirs = new Map((await r.tx.topicFact.findMany({ where: { topicId: intoId, status: live } })).map((f) => [f.topicFactId, f]));
    let disputed = 0;
    for (const fact of await r.tx.topicFact.findMany({ where: { topicId: fromId, status: { not: "WRONG" } } })) {
      const other = fact.status === "SUPERSEDED" ? undefined : [...theirs.values()].find((t) => sameAbout(t.about, fact.about));
      if (!other) {
        await r.update(fact, { topicId: intoId });
      } else if (other.statement.trim() === fact.statement.trim()) {
        await r.update(fact, { topicId: intoId, status: "SUPERSEDED", supersededById: other.topicFactId });
      } else {
        await r.update(fact, { topicId: intoId, status: "DISPUTED" });
        if (other.status !== "DISPUTED") theirs.set(other.topicFactId, await r.update(other, { status: "DISPUTED" }));
        disputed++;
      }
    }
    for (const d of from.directions) {
      const twin = into.directions.some((t) => t.kind === d.kind && t.value === d.value && (t.about ?? "") === (d.about ?? ""));
      if (!twin) await r.move("direction", d.topicDirectionId, fromId, intoId);
    }
    for (const s of from.sources) {
      if (!into.sources.some((t) => t.kind === s.kind && t.location === s.location && t.path === s.path)) {
        await r.move("source", s.topicSourceId, fromId, intoId);
      }
    }
    const theirEmails = new Set(
      (await r.tx.topicLink.findMany({ where: { topicId: intoId }, select: { messageId: true } })).map((l) => l.messageId),
    );
    for (const l of await r.tx.topicLink.findMany({ where: { topicId: fromId } })) {
      if (!theirEmails.has(l.messageId)) await r.move("link", l.topicLinkId, fromId, intoId);
    }
    await r.topicStatus(fromId, from.status, "ARCHIVED");
    meta.summary = `Merged ${from.name} into ${into.name}${disputed ? `: ${disputed} fact${disputed === 1 ? "" : "s"} in dispute` : ""}`;
    return { disputed };
  });
}

function same(a: FactSnapshot | null, b: FactSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return (Object.keys(a) as (keyof FactSnapshot)[]).every((key) => a[key] === b[key]);
}

/** A fact proposal from topic.extract, approved at a gate (M42-T2). */
export interface FactProposal {
  topicId: string;
  kind: "new" | "change" | "conflict";
  about: string;
  statement: string;
  quote: string;
  /** The fact it changes or disputes. */
  replaces: { topicFactId: string } | null;
  /** An email, or a file of a topic's source (M43: messageId "owner/repo:path", from the repository, subject the path). */
  source: { kind?: "email" | "file" | "edit"; messageId: string; from: string; subject: string; date: string; commit?: string };
  /** One line, for the gate and the history: "Orion: Launch date: February → March (Maria, 2026-11-12)". */
  title: string;
}

/** Why a proposal was not written, or null when it was. */
export type ApplyOutcome = { applied: true; topicFactId: string } | { applied: false; reason: string };

/**
 * Writes an approved proposal (topic.apply, M42-T2). Evidence counts by the date of its source, not the order it was
 * read: a change from a source older than the fact it replaces goes into the history (superseded by it), so reading
 * email N+100 before email N leaves the newer fact current. A pinned fact (the user's) is never replaced: the proposal
 * puts both in dispute. Nothing a source was said to be wrong about is written from it again.
 */
export async function applyProposal(
  prisma: PrismaClient,
  userId: string,
  proposal: FactProposal,
  runId: string | null,
): Promise<ApplyOutcome> {
  const topic = await prisma.topic.findFirst({ where: { topicId: proposal.topicId, userId } });
  if (!topic) return { applied: false, reason: "the topic is gone" };
  const fromSource = await prisma.topicFact.findMany({ where: { userId, topicId: proposal.topicId, sourceId: proposal.source.messageId } });
  const same = fromSource.filter((f) => sameAbout(f.about, proposal.about));
  if (same.some((f) => f.status === "WRONG")) return { applied: false, reason: "you said this source was wrong about it" };
  if (same.some((f) => f.statement.trim() === proposal.statement.trim())) return { applied: false, reason: "already known" };

  const target = await head(prisma, userId, proposal);
  const sourceDate = new Date(proposal.source.date);
  const fact = {
    userId,
    topicId: proposal.topicId,
    about: proposal.about,
    statement: proposal.statement,
    // The user's own edit of a draft (M44-T3): theirs, pinned, like a fact they wrote.
    source: proposal.source.kind === "file" ? ("FILE" as const) : proposal.source.kind === "edit" ? ("USER" as const) : ("EMAIL" as const),
    sourceId: proposal.source.kind === "edit" ? null : proposal.source.messageId,
    pinned: proposal.source.kind === "edit",
    sourceLabel: (proposal.source.kind === "file"
      ? `${proposal.source.from} ${proposal.source.subject}${proposal.source.commit ? ` @ ${proposal.source.commit.slice(0, 7)}` : ""}`
      : proposal.source.kind === "edit"
        ? `you, in your reply "${proposal.source.subject}"`
        : `${proposal.source.from}: ${proposal.source.subject || "(no subject)"}`
    ).slice(0, 300),
    sourceDate: Number.isNaN(sourceDate.getTime()) ? new Date() : sourceDate,
    quote: proposal.quote.slice(0, 500),
    runId,
  };
  if (target && target.statement.trim() === proposal.statement.trim()) return { applied: false, reason: "already known" };

  return change(
    prisma,
    { userId, topicId: proposal.topicId, kind: "APPLY", summary: proposal.title, runId: runId ?? undefined },
    async (r) => {
      if (!target) {
        const created = await r.create({ ...fact, status: "CURRENT" });
        return { applied: true as const, topicFactId: created.topicFactId };
      }
      // The user's own correction replaces even a pinned fact; anything else only disputes it.
      const yours = proposal.source.kind === "edit";
      if (proposal.kind === "conflict" || (target.pinned && !yours) || target.status === "DISPUTED") {
        const created = await r.create({ ...fact, status: "DISPUTED" });
        if (target.status !== "DISPUTED") await r.update(target, { status: "DISPUTED" });
        return { applied: true as const, topicFactId: created.topicFactId };
      }
      if (fact.sourceDate < target.sourceDate) {
        // Older evidence: history, not news.
        const created = await r.create({ ...fact, status: "SUPERSEDED", supersededById: target.topicFactId });
        return { applied: true as const, topicFactId: created.topicFactId };
      }
      const created = await r.create({ ...fact, status: "CURRENT" });
      await r.update(target, { status: "SUPERSEDED", supersededById: created.topicFactId });
      return { applied: true as const, topicFactId: created.topicFactId };
    },
  );
}

/**
 * The fact a proposal is about now: the one it names, followed to what superseded it since; else the current one about
 * the same thing (a "new" fact about something the topic already knows is a change).
 */
async function head(prisma: PrismaClient, userId: string, proposal: FactProposal): Promise<TopicFact | null> {
  let fact = proposal.replaces
    ? await prisma.topicFact.findFirst({ where: { topicFactId: proposal.replaces.topicFactId, userId, topicId: proposal.topicId } })
    : null;
  for (let hops = 0; fact?.status === "SUPERSEDED" && fact.supersededById && hops < 20; hops++) {
    fact = await prisma.topicFact.findUnique({ where: { topicFactId: fact.supersededById } });
  }
  if (fact && (fact.status === "CURRENT" || fact.status === "DISPUTED")) return fact;
  const current = await prisma.topicFact.findMany({
    where: { userId, topicId: proposal.topicId, status: { in: ["CURRENT", "DISPUTED"] } },
  });
  return current.find((f) => sameAbout(f.about, proposal.about)) ?? null;
}
