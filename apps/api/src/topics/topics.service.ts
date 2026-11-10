import { type Topic, type TopicDirection } from "@realentity/storm-db";
import { type TopicDirectionView, type TopicView } from "@realentity/storm-shared";
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
    return topics.map(topicView);
  }

  async get(userId: string, topicId: string): Promise<TopicView> {
    return topicView(await this.own(userId, topicId));
  }

  async create(userId: string, request: { name: string; description: string }): Promise<TopicView> {
    await this.nameFree(userId, request.name, null);
    const topic = await this.prisma.client.topic.create({ data: { userId, ...request }, include: { directions: true } });
    return topicView(topic);
  }

  async update(
    userId: string,
    topicId: string,
    request: { name: string; description: string; status: Topic["status"] },
  ): Promise<TopicView> {
    await this.own(userId, topicId);
    await this.nameFree(userId, request.name, topicId);
    const topic = await this.prisma.client.topic.update({
      where: { topicId },
      data: request,
      include: { directions: { orderBy: { dateCreated: "asc" } } },
    });
    return topicView(topic);
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

export function topicView(topic: Topic & { directions: TopicDirection[] }): TopicView {
  return {
    topicId: topic.topicId,
    name: topic.name,
    description: topic.description,
    status: topic.status,
    directions: topic.directions.map(directionView),
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
