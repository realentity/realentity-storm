import { type PrismaClient } from "@realentity/storm-db";
import { type EmailMessage } from "@realentity/storm-steps";
import { z } from "zod";

/** A topic's memory in a draft's prompt, at most (M42-T3): the description and current facts, newest first when cut. */
export const MEMORY_TEXT = 6_000;

/** Facts, by the short reference the model answers with ("F3"), as the gate shows them. */
export type MemoryRefs = Map<string, string>;

export interface TopicMemory {
  /** The <memory> block ("" without a topic). */
  block: string;
  refs: MemoryRefs;
  topics: string[];
}

export const NO_MEMORY: TopicMemory = { block: "", refs: new Map(), topics: [] };

/** What a draft says it used, besides its text: the references of the facts. */
export const UsedFacts = z.array(z.string().max(10)).max(40).describe("references (F1, F2…) of the <memory> facts the text relies on");

export const MEMORY_RULE =
  "<memory> is what the user's own approved memory of the email's topics says is true now. Use it where the text needs " +
  "it and never contradict it; for what neither it nor the email says, still write a placeholder. List the references " +
  "of the facts you relied on in `used`.";

/**
 * A draft's topics (M42-T3, docs/design.md §8.1): `auto` uses the email's topics that aren't waiting for the user (linked
 * by a direction or its thread, or confirmed), else its thread's; `none` none; else the topic of that name. Only current
 * facts go in.
 */
export async function topicMemory(
  prisma: PrismaClient | undefined,
  userId: string,
  message: EmailMessage,
  topic: string,
): Promise<TopicMemory> {
  if (!prisma || topic === "none") return NO_MEMORY;
  const topics =
    topic === "auto" ? await linkedTopics(prisma, userId, message) : await prisma.topic.findMany({ where: { userId, name: topic } });
  if (topic !== "auto" && topics.length === 0) throw new Error(`No topic named "${topic}"`);
  if (topics.length === 0) return NO_MEMORY;

  const refs: MemoryRefs = new Map();
  const cards: string[] = [];
  let budget = MEMORY_TEXT;
  for (const t of topics) {
    const facts = await prisma.topicFact.findMany({
      where: { userId, topicId: t.topicId, status: "CURRENT" },
      orderBy: { sourceDate: "desc" },
    });
    const lines: string[] = [];
    for (const fact of facts) {
      const ref = `F${refs.size + 1}`;
      const line = `- ${ref}: ${fact.about}: ${fact.statement} (${fact.source === "USER" ? "the user" : fact.sourceLabel}, ${fact.sourceDate.toISOString().slice(0, 10)})`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
      refs.set(ref, `${t.name}: ${fact.about}: ${fact.statement} (${fact.source === "USER" ? "yours" : fact.sourceLabel})`);
    }
    const description = t.description.slice(0, Math.max(0, budget));
    budget -= description.length;
    cards.push([`<topic name="${t.name}">`, description, ...(lines.length ? lines : ["(no facts yet)"]), "</topic>"].join("\n"));
  }
  return { block: `<memory>\n${cards.join("\n")}\n</memory>\n\n`, refs, topics: topics.map((t) => t.name) };
}

async function linkedTopics(prisma: PrismaClient, userId: string, message: EmailMessage) {
  const settled = { userId, status: { in: ["LINKED" as const, "CONFIRMED" as const] } };
  const own = await prisma.topicLink.findMany({ where: { ...settled, messageId: message.messageId }, include: { topic: true } });
  // The user's own email (a follow-up) isn't linked itself: its thread is.
  const links = own.length
    ? own
    : message.threadId
      ? await prisma.topicLink.findMany({ where: { ...settled, threadId: message.threadId }, include: { topic: true } })
      : [];
  return [...new Map(links.map((l) => [l.topicId, l.topic])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the gate shows the draft drew on: its topics, and the facts it says it used. */
export function drewOn(memory: TopicMemory, used: string[]): string[] {
  if (memory.topics.length === 0) return [];
  const facts = [...new Set(used.map((u) => u.trim()))].flatMap((ref) => memory.refs.get(ref) ?? []);
  return facts.length ? facts : [`${memory.topics.join(", ")}: no fact it knows was needed`];
}
