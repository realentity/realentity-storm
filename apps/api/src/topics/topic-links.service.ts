import { type Topic, type TopicLink } from "@realentity/storm-db";
import { type TopicLinkView } from "@realentity/storm-shared";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const WAITING_LIMIT = 200;
const TOPIC_EMAILS_LIMIT = 50;

/**
 * An email's topics (M41-T4, docs/design.md §8.1): the queue of suggested links and each topic's emails. The user
 * confirms, rejects or moves a link; topic.match never rewrites their decision and learns from it.
 */
@Injectable()
export class TopicLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** What waits for the user: links only the LLM suggested, newest email first. */
  async waiting(userId: string): Promise<TopicLinkView[]> {
    const links = await this.prisma.client.topicLink.findMany({
      where: { userId, status: "SUGGESTED", topic: { status: "ACTIVE" } },
      include: { topic: true },
      orderBy: { date: "desc" },
      take: WAITING_LIMIT,
    });
    return links.map(linkView);
  }

  /** A topic's emails, newest first; ones the user rejected left out. */
  async ofTopic(userId: string, topicId: string): Promise<TopicLinkView[]> {
    const links = await this.prisma.client.topicLink.findMany({
      where: { userId, topicId, status: { not: "REJECTED" } },
      include: { topic: true },
      orderBy: { date: "desc" },
      take: TOPIC_EMAILS_LIMIT,
    });
    return links.map(linkView);
  }

  async confirm(userId: string, topicLinkId: string): Promise<TopicLinkView> {
    await this.own(userId, topicLinkId);
    return linkView(
      await this.prisma.client.topicLink.update({ where: { topicLinkId }, data: { status: "CONFIRMED" }, include: { topic: true } }),
    );
  }

  async reject(userId: string, topicLinkId: string): Promise<TopicLinkView> {
    await this.own(userId, topicLinkId);
    return linkView(
      await this.prisma.client.topicLink.update({ where: { topicLinkId }, data: { status: "REJECTED" }, include: { topic: true } }),
    );
  }

  /** The email belongs to another topic instead: this link rejected, that one confirmed (made if it isn't there). */
  async move(userId: string, topicLinkId: string, topicId: string): Promise<TopicLinkView> {
    const link = await this.own(userId, topicLinkId);
    if (link.topicId === topicId) throw new BadRequestException("It is in this topic already");
    const target = await this.prisma.client.topic.findFirst({ where: { topicId, userId } });
    if (!target) throw new NotFoundException();
    const email = { userId, messageId: link.messageId, threadId: link.threadId, from: link.from, subject: link.subject, date: link.date };
    const [, moved] = await this.prisma.client.$transaction([
      this.prisma.client.topicLink.update({ where: { topicLinkId }, data: { status: "REJECTED" } }),
      this.prisma.client.topicLink.upsert({
        where: { topicId_messageId: { topicId, messageId: link.messageId } },
        create: { ...email, topicId, status: "CONFIRMED", via: "USER", evidence: `moved here from ${link.topic.name} by you` },
        update: { status: "CONFIRMED" },
        include: { topic: true },
      }),
    ]);
    return linkView(moved);
  }

  private async own(userId: string, topicLinkId: string): Promise<TopicLink & { topic: Topic }> {
    const link = await this.prisma.client.topicLink.findFirst({ where: { topicLinkId, userId }, include: { topic: true } });
    if (!link) throw new NotFoundException();
    return link;
  }
}

export function linkView(link: TopicLink & { topic: Topic }): TopicLinkView {
  return {
    topicLinkId: link.topicLinkId,
    topicId: link.topicId,
    topicName: link.topic.name,
    messageId: link.messageId,
    threadId: link.threadId,
    from: link.from,
    subject: link.subject,
    date: link.date.toISOString(),
    status: link.status,
    via: link.via,
    evidence: link.evidence,
    dateCreated: link.dateCreated.toISOString(),
  };
}
