import {
  addFact,
  editFact,
  markWrong,
  mergeTopics,
  moveFact,
  noLongerTrue,
  settleFact,
  splitTopic,
  TopicMemoryError,
  undoChange,
  type TopicChange,
  type TopicFact,
} from "@realentity/storm-db";
import { type TopicChangeView, type TopicFactView } from "@realentity/storm-shared";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const CHANGES_LIMIT = 50;

/**
 * A topic's facts (M42-T1, docs/design.md §8.1): the user's changes to them (edit, no longer true, wrong, move, which
 * holds), each recorded and undoable. The work is in @realentity/storm-db's topic-memory, shared with topic.apply.
 */
@Injectable()
export class TopicFactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A topic's facts, the wrong ones left out: current and in dispute first, by what they are about; then the history. */
  async ofTopic(userId: string, topicId: string): Promise<TopicFactView[]> {
    await this.ownTopic(userId, topicId);
    const facts = await this.prisma.client.topicFact.findMany({
      where: { userId, topicId, status: { not: "WRONG" } },
      orderBy: [{ about: "asc" }, { sourceDate: "desc" }],
    });
    const rank = (f: TopicFact) => (f.status === "SUPERSEDED" ? 1 : 0);
    return facts.sort((a, b) => rank(a) - rank(b)).map(factView);
  }

  /** The topic's changes, newest first: its own, and facts moved into it. */
  async changes(userId: string, topicId: string): Promise<TopicChangeView[]> {
    await this.ownTopic(userId, topicId);
    const changes = await this.prisma.client.topicChange.findMany({
      where: { userId, OR: [{ topicId }, { otherTopicId: topicId }] },
      orderBy: { dateCreated: "desc" },
      take: CHANGES_LIMIT,
    });
    return changes.map(changeView);
  }

  add(userId: string, topicId: string, fact: { about: string; statement: string }): Promise<TopicFactView> {
    return mapped(async () => factView(await addFact(this.prisma.client, userId, topicId, fact)));
  }

  edit(userId: string, topicFactId: string, fact: { about: string; statement: string }): Promise<TopicFactView> {
    return mapped(async () => factView(await editFact(this.prisma.client, userId, topicFactId, fact)));
  }

  noLongerTrue(userId: string, topicFactId: string, statement: string | undefined): Promise<TopicFactView> {
    return mapped(async () => factView(await noLongerTrue(this.prisma.client, userId, topicFactId, statement)));
  }

  wrong(userId: string, topicFactId: string): Promise<void> {
    return mapped(() => markWrong(this.prisma.client, userId, topicFactId));
  }

  settle(userId: string, topicFactId: string): Promise<TopicFactView> {
    return mapped(async () => factView(await settleFact(this.prisma.client, userId, topicFactId)));
  }

  move(userId: string, topicFactId: string, topicId: string): Promise<TopicFactView> {
    return mapped(async () => factView(await moveFact(this.prisma.client, userId, topicFactId, topicId)));
  }

  /** Split (M44-T4): the chosen facts, directions, sources and emails move to a new topic. */
  split(
    userId: string,
    topicId: string,
    request: { name: string; description: string; facts: string[]; directions: string[]; sources: string[]; links: string[] },
  ): Promise<{ topicId: string }> {
    return mapped(() => splitTopic(this.prisma.client, userId, topicId, request));
  }

  /** Merge (M44-T4): this topic into another; facts they disagree on put in dispute. */
  merge(userId: string, topicId: string, into: string): Promise<{ disputed: number }> {
    return mapped(() => mergeTopics(this.prisma.client, userId, topicId, into));
  }

  undo(userId: string, topicChangeId: string): Promise<void> {
    return mapped(() => undoChange(this.prisma.client, userId, topicChangeId));
  }

  private async ownTopic(userId: string, topicId: string): Promise<void> {
    if (!(await this.prisma.client.topic.findFirst({ where: { topicId, userId }, select: { topicId: true } }))) {
      throw new NotFoundException();
    }
  }
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TopicMemoryError)) throw error;
    if (error.code === "not_found") throw new NotFoundException(error.message);
    if (error.code === "conflict") throw new ConflictException(error.message);
    throw new BadRequestException(error.message);
  }
}

export function factView(fact: TopicFact): TopicFactView {
  return {
    topicFactId: fact.topicFactId,
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
    dateUpdated: fact.dateUpdated.toISOString(),
  };
}

function changeView(change: TopicChange): TopicChangeView {
  return {
    topicChangeId: change.topicChangeId,
    topicId: change.topicId,
    otherTopicId: change.otherTopicId,
    kind: change.kind,
    summary: change.summary,
    byRun: change.runId !== null,
    undone: change.undoneAt !== null,
    dateCreated: change.dateCreated.toISOString(),
  };
}
