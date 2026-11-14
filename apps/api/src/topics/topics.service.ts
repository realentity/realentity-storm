import { topicCostsSince, type Topic, type TopicDirection } from "@realentity/storm-db";
import { factsThatFit, type TopicCounts, type TopicDirectionView, type TopicView } from "@realentity/storm-shared";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

type Direction = Pick<TopicDirection, "kind" | "value" | "about">;

/**
 * Topics (M41-T2, docs/design.md §8.1): subjects Storm keeps a memory of, and their directions. Only the user writes them
 * here (a suggestion becomes a direction only when they approve it, M44).
 */
@Injectable()
export class TopicsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<TopicView[]> {
    const topics = await this.prisma.client.topic.findMany({
      where: { userId },
      include: { directions: { orderBy: { dateCreated: "asc" } } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    });
    const [costs, counts] = await Promise.all([
      topicCostsSince(this.prisma.client, userId, new Date(Date.now() - COST_DAYS * DAY_MS)),
      topicCounts(this.prisma, userId, topics),
    ]);
    return topics.map((t) => topicView(t, costs.find((c) => c.topicId === t.topicId)?.costUsd ?? 0, counts.get(t.topicId)));
  }

  async get(userId: string, topicId: string): Promise<TopicView> {
    const topic = await this.own(userId, topicId);
    const [costs, counts] = await Promise.all([
      topicCostsSince(this.prisma.client, userId, new Date(Date.now() - COST_DAYS * DAY_MS)),
      topicCounts(this.prisma, userId, [topic]),
    ]);
    return topicView(topic, costs.find((c) => c.topicId === topicId)?.costUsd ?? 0, counts.get(topicId));
  }

  async create(userId: string, request: { name: string; description: string }): Promise<TopicView> {
    await this.nameFree(userId, request.name, null);
    const topic = await this.prisma.client.topic.create({ data: { userId, ...request }, include: { directions: true } });
    return topicView(topic);
  }

  async update(
    userId: string,
    topicId: string,
    request: { name?: string; description?: string; status?: Topic["status"] },
  ): Promise<TopicView> {
    await this.own(userId, topicId);
    if (request.name !== undefined) await this.nameFree(userId, request.name, topicId);
    await this.prisma.client.topic.update({ where: { topicId }, data: request });
    return this.get(userId, topicId);
  }

  async remove(userId: string, topicId: string): Promise<void> {
    await this.own(userId, topicId);
    await this.prisma.client.topic.delete({ where: { topicId } });
  }

  async addDirection(userId: string, topicId: string, direction: Direction): Promise<TopicView> {
    const topic = await this.own(userId, topicId);
    if (topic.directions.some((d) => sameDirection(d, direction))) throw new ConflictException("The topic has this direction already");
    await this.prisma.client.topicDirection.create({ data: { topicId, ...direction } });
    return this.get(userId, topicId);
  }

  async removeDirection(userId: string, topicId: string, topicDirectionId: string): Promise<TopicView> {
    const topic = await this.own(userId, topicId);
    if (!topic.directions.some((d) => d.topicDirectionId === topicDirectionId)) throw new NotFoundException();
    await this.prisma.client.topicDirection.delete({ where: { topicDirectionId } });
    return this.get(userId, topicId);
  }

  private async own(userId: string, topicId: string): Promise<Topic & { directions: TopicDirection[] }> {
    const topic = await this.prisma.client.topic.findFirst({
      where: { topicId, userId },
      include: { directions: { orderBy: { dateCreated: "asc" } } },
    });
    if (!topic) throw new NotFoundException();
    return topic;
  }

  /** Names are unique per user, in any case (citext). */
  private async nameFree(userId: string, name: string, topicId: string | null): Promise<void> {
    const clash = await this.prisma.client.topic.findUnique({ where: { userId_name: { userId, name } } });
    if (clash && clash.topicId !== topicId) throw new ConflictException(`There is a topic "${clash.name}" already`);
  }
}

function sameDirection(a: Direction, b: Direction): boolean {
  return (
    a.kind === b.kind && a.value.toLowerCase() === b.value.toLowerCase() && (a.about ?? "").toLowerCase() === (b.about ?? "").toLowerCase()
  );
}

/** A topic's cost on its card: the last 30 days. */
const COST_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const NO_COUNTS: TopicCounts = { facts: 0, fit: 0, disputed: 0, sources: 0, emails: 0 };

/** What each topic holds, for the list: its current facts (and how many fit in a draft), disputes, sources, emails. */
export async function topicCounts(
  prisma: PrismaService,
  userId: string,
  topics: { topicId: string; description: string }[],
): Promise<Map<string, TopicCounts>> {
  const topicId = { in: topics.map((t) => t.topicId) };
  const [facts, disputed, sources, emails] = await Promise.all([
    prisma.client.topicFact.findMany({
      where: { userId, topicId, status: "CURRENT" },
      select: { topicId: true, about: true, statement: true, source: true, sourceLabel: true, sourceDate: true },
    }),
    prisma.client.topicFact.groupBy({ by: ["topicId"], where: { userId, topicId, status: "DISPUTED" }, _count: { _all: true } }),
    prisma.client.topicSource.groupBy({ by: ["topicId"], where: { userId, topicId }, _count: { _all: true } }),
    prisma.client.topicLink.groupBy({
      by: ["topicId"],
      where: { userId, topicId, status: { in: ["LINKED", "CONFIRMED"] } },
      _count: { _all: true },
    }),
  ]);
  const count = (rows: { topicId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.topicId === id)?._count._all ?? 0;
  return new Map(
    topics.map((t) => {
      const current = facts.filter((f) => f.topicId === t.topicId);
      const counts: TopicCounts = {
        facts: current.length,
        fit: factsThatFit(t.description, current),
        disputed: count(disputed, t.topicId),
        sources: count(sources, t.topicId),
        emails: count(emails, t.topicId),
      };
      return [t.topicId, counts];
    }),
  );
}

export function topicView(topic: Topic & { directions: TopicDirection[] }, costUsd30 = 0, counts = NO_COUNTS): TopicView {
  return {
    topicId: topic.topicId,
    name: topic.name,
    description: topic.description,
    status: topic.status,
    directions: topic.directions.map(directionView),
    costUsd30: Math.round(costUsd30 * 10_000) / 10_000,
    counts,
    dateCreated: topic.dateCreated.toISOString(),
    dateUpdated: topic.dateUpdated.toISOString(),
  };
}

function directionView(direction: TopicDirection): TopicDirectionView {
  return {
    topicDirectionId: direction.topicDirectionId,
    kind: direction.kind,
    value: direction.value,
    about: direction.about,
    dateCreated: direction.dateCreated.toISOString(),
  };
}
