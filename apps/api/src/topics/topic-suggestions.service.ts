import { applyProposal, type Prisma, type TopicSuggestion } from "@realentity/storm-db";
import { isFreeMailDomain, looksSecret, matchDirections, normalizeDirection, type TopicSuggestionView } from "@realentity/storm-shared";
import { TopicProposalSchema } from "@realentity/storm-steps";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { TopicsService } from "./topics.service";

/** A person's emails the user confirmed for a topic before Storm suggests them as its direction. */
export const PERSON_MIN = 3;
/** A domain: this many emails, from this many people. */
export const DOMAIN_MIN_EMAILS = 4;
export const DOMAIN_MIN_PEOPLE = 2;

interface DirectionPayload {
  kind: "PERSON" | "DOMAIN";
  value: string;
  about: string | null;
}

/**
 * What Storm suggests for topics (M44, docs/design.md §8.1). Directions come from the user's own decisions, without an
 * LLM: a person (or a domain's people) whose emails they confirmed or moved into a topic, none rejected, sending to no
 * other topic. Nothing is active before the user accepts it; a dismissed suggestion isn't made again.
 */
@Injectable()
export class TopicSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly topics: TopicsService,
  ) {}

  /** The open suggestions, the directions brought up to date first. */
  async open(userId: string): Promise<TopicSuggestionView[]> {
    await this.suggestDirections(userId);
    const open = await this.prisma.client.topicSuggestion.findMany({
      where: { userId, status: "OPEN", OR: [{ topicId: null }, { topic: { status: "ACTIVE" } }] },
      include: { topic: true },
      orderBy: { dateCreated: "asc" },
    });
    return open.map((s) => suggestionView(s, s.topic?.name ?? null));
  }

  async accept(userId: string, topicSuggestionId: string): Promise<TopicSuggestionView> {
    const suggestion = await this.own(userId, topicSuggestionId);
    if (suggestion.kind === "DIRECTION" && suggestion.topicId) {
      const direction = suggestion.payload as unknown as DirectionPayload;
      try {
        await this.topics.addDirection(userId, suggestion.topicId, direction);
      } catch (error) {
        // Added by hand meanwhile: accepted all the same.
        if (!(error instanceof ConflictException)) throw error;
      }
    } else if (suggestion.kind === "FACT") {
      const proposal = TopicProposalSchema.parse(suggestion.payload);
      if (!looksSecret(`${proposal.about} ${proposal.statement} ${proposal.quote}`))
        await applyProposal(this.prisma.client, userId, proposal, null);
    } else if (suggestion.kind === "TOPIC") {
      const topic = suggestion.payload as unknown as { name: string; description: string; directions: DirectionPayload[] };
      const made = await this.topics.create(userId, { name: topic.name, description: topic.description });
      for (const direction of topic.directions) await this.topics.addDirection(userId, made.topicId, direction).catch(() => undefined);
    }
    return this.decide(suggestion, "ACCEPTED");
  }

  async dismiss(userId: string, topicSuggestionId: string): Promise<TopicSuggestionView> {
    return this.decide(await this.own(userId, topicSuggestionId), "DISMISSED");
  }

  /**
   * Directions from the user's decisions on email links: for each active topic, the people (and domains) whose emails
   * they confirmed for it, none rejected, none confirmed for another topic, not covered by its directions already.
   */
  async suggestDirections(userId: string): Promise<void> {
    const [topics, decided] = await Promise.all([
      this.prisma.client.topic.findMany({ where: { userId, status: "ACTIVE" }, include: { directions: true } }),
      this.prisma.client.topicLink.findMany({
        where: { userId, status: { in: ["CONFIRMED", "REJECTED"] } },
        select: { topicId: true, from: true, messageId: true, status: true },
      }),
    ]);
    const suggestions: Prisma.TopicSuggestionCreateManyInput[] = [];
    for (const topic of topics) {
      const covered = (address: string) =>
        matchDirections({ from: address, to: [], cc: [], subject: "", text: "" }, topic.directions).exact !== null ||
        topic.directions.some((d) => d.kind === "PERSON" && d.value === address);
      const mine = decided.filter((d) => d.topicId === topic.topicId);
      const others = decided.filter((d) => d.topicId !== topic.topicId && d.status === "CONFIRMED");
      const rejected = new Set(mine.filter((d) => d.status === "REJECTED").map((d) => d.from.toLowerCase()));
      const confirmed = new Map<string, Set<string>>();
      for (const d of mine.filter((m) => m.status === "CONFIRMED")) {
        const from = d.from.toLowerCase();
        confirmed.set(from, (confirmed.get(from) ?? new Set()).add(d.messageId));
      }
      const elsewhere = (address: string) => others.some((o) => o.from.toLowerCase() === address);
      const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

      // A domain first: it covers its people.
      const byDomain = new Map<string, string[]>();
      for (const address of confirmed.keys()) byDomain.set(domainOf(address), [...(byDomain.get(domainOf(address)) ?? []), address]);
      const domains = new Set<string>();
      for (const [domain, people] of byDomain) {
        const emails = people.reduce((sum, p) => sum + confirmed.get(p)!.size, 0);
        const clean =
          !isFreeMailDomain(domain) &&
          ![...rejected].some((r) => domainOf(r) === domain) &&
          !others.some((o) => domainOf(o.from.toLowerCase()) === domain);
        if (clean && people.length >= DOMAIN_MIN_PEOPLE && emails >= DOMAIN_MIN_EMAILS && !people.every(covered)) {
          domains.add(domain);
          suggestions.push(
            direction(
              userId,
              topic.topicId,
              { kind: "DOMAIN", value: domain, about: null },
              `you confirmed ${emails} emails from ${people.length} people at ${domain} for ${topic.name}`,
            ),
          );
        }
      }
      for (const [address, emails] of confirmed) {
        if (domains.has(domainOf(address)) || rejected.has(address) || elsewhere(address) || covered(address)) continue;
        if (emails.size < PERSON_MIN) continue;
        const normalized = normalizeDirection({ kind: "PERSON", value: address });
        if ("error" in normalized) continue;
        suggestions.push(
          direction(
            userId,
            topic.topicId,
            { kind: "PERSON", value: normalized.value, about: null },
            `you confirmed ${emails.size} of their emails for ${topic.name} and rejected none`,
          ),
        );
      }
    }
    // Made once: an open, accepted or dismissed one with the same key stays as it is.
    if (suggestions.length) await this.prisma.client.topicSuggestion.createMany({ data: suggestions, skipDuplicates: true });
  }

  private async decide(suggestion: TopicSuggestion, status: "ACCEPTED" | "DISMISSED"): Promise<TopicSuggestionView> {
    if (suggestion.status !== "OPEN") throw new ConflictException("It is decided already");
    const decided = await this.prisma.client.topicSuggestion.update({
      where: { topicSuggestionId: suggestion.topicSuggestionId },
      data: { status, decidedAt: new Date() },
      include: { topic: true },
    });
    return suggestionView(decided, decided.topic?.name ?? null);
  }

  private async own(userId: string, topicSuggestionId: string): Promise<TopicSuggestion> {
    const suggestion = await this.prisma.client.topicSuggestion.findFirst({ where: { topicSuggestionId, userId } });
    if (!suggestion) throw new NotFoundException();
    return suggestion;
  }
}

function direction(userId: string, topicId: string, payload: DirectionPayload, reason: string): Prisma.TopicSuggestionCreateManyInput {
  return {
    userId,
    topicId,
    kind: "DIRECTION",
    key: `DIRECTION:${topicId}:${payload.kind}:${payload.value}`,
    payload: payload as unknown as Prisma.InputJsonValue,
    reason,
  };
}

function suggestionView(s: TopicSuggestion, topicName: string | null): TopicSuggestionView {
  return {
    topicSuggestionId: s.topicSuggestionId,
    topicId: s.topicId,
    topicName,
    kind: s.kind,
    payload: s.payload as Record<string, unknown>,
    reason: s.reason,
    status: s.status,
    dateCreated: s.dateCreated.toISOString(),
  };
}
