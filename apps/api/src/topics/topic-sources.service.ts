import { type TopicSource } from "@realentity/storm-db";
import { type TopicSourceView } from "@realentity/storm-shared";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const GITHUB_API = "api.github.com";

/**
 * A topic's sources (M43, docs/design.md §8.1): where its documents live, linked and never copied. Rebuild deletes the
 * index (a cache) and where the source was read to; the next read makes it again.
 */
@Injectable()
export class TopicSourcesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, topicId: string): Promise<TopicSourceView[]> {
    await this.ownTopic(userId, topicId);
    const sources = await this.prisma.client.topicSource.findMany({
      where: { userId, topicId },
      include: { _count: { select: { passages: true } }, googleAccount: ACCOUNT },
      orderBy: { dateCreated: "asc" },
    });
    return sources.map((s) => sourceView(s, s._count.passages));
  }

  async add(
    userId: string,
    topicId: string,
    request: {
      kind: "GITHUB" | "DRIVE";
      location: string;
      branch?: string | null;
      path: string;
      credential?: string | null;
      googleAccountId?: string | null;
    },
  ): Promise<TopicSourceView> {
    await this.ownTopic(userId, topicId);
    const clash = await this.prisma.client.topicSource.findFirst({ where: { topicId, location: request.location, path: request.path } });
    if (clash) throw new ConflictException("The topic has this source already");
    if (request.kind === "DRIVE") {
      // Read through one of the user's Google accounts (M50-T8), else the default. Whether it allows Drive shows on the
      // form and on the source's first read.
      const google = request.googleAccountId
        ? await this.prisma.client.googleAccount.findFirst({
            where: { userId, googleAccountId: request.googleAccountId },
            select: { userId: true },
          })
        : await this.prisma.client.googleAccount.findFirst({ where: { userId }, select: { userId: true } });
      if (!google) {
        throw new BadRequestException(
          request.googleAccountId
            ? "No such Google account"
            : "Connect Google in Settings first (Google Calendar and Drive), and allow Drive",
        );
      }
    }
    if (request.credential) {
      const credential = await this.prisma.client.credential.findFirst({ where: { userId, name: request.credential } });
      if (!credential) throw new BadRequestException(`There is no credential "${request.credential}"`);
      if (!credential.allowedHosts.some((host) => host.toLowerCase() === GITHUB_API)) {
        throw new BadRequestException(`The credential "${request.credential}" must allow ${GITHUB_API} (its allowed hosts)`);
      }
    }
    const source = await this.prisma.client.topicSource.create({
      data: {
        userId,
        topicId,
        kind: request.kind,
        location: request.location,
        branch: request.branch ?? null,
        path: request.path,
        credential: request.credential ?? null,
        googleAccountId: request.kind === "DRIVE" ? (request.googleAccountId ?? null) : null,
      },
      include: { googleAccount: ACCOUNT },
    });
    return sourceView(source, 0);
  }

  async remove(userId: string, topicSourceId: string): Promise<void> {
    await this.own(userId, topicSourceId);
    await this.prisma.client.topicSource.delete({ where: { topicSourceId } });
  }

  /** The index and the position go: the next read indexes every file again. */
  async rebuild(userId: string, topicSourceId: string): Promise<TopicSourceView> {
    await this.own(userId, topicSourceId);
    const [, source] = await this.prisma.client.$transaction([
      this.prisma.client.topicPassage.deleteMany({ where: { topicSourceId } }),
      this.prisma.client.topicSource.update({
        where: { topicSourceId },
        data: { cursor: null, readAt: null },
        include: { googleAccount: ACCOUNT },
      }),
    ]);
    return sourceView(source, 0);
  }

  private async own(userId: string, topicSourceId: string): Promise<TopicSource> {
    const source = await this.prisma.client.topicSource.findFirst({ where: { topicSourceId, userId } });
    if (!source) throw new NotFoundException();
    return source;
  }

  private async ownTopic(userId: string, topicId: string): Promise<void> {
    if (!(await this.prisma.client.topic.findFirst({ where: { topicId, userId }, select: { topicId: true } })))
      throw new NotFoundException();
  }
}

/** A Drive source's Google account, as its view shows it. */
const ACCOUNT = { select: { googleAccountId: true, email: true } } as const;

function sourceView(
  source: TopicSource & { googleAccount: { googleAccountId: string; email: string } | null },
  passages: number,
): TopicSourceView {
  const folder = /[*?{]/.test(source.path) ? source.path.slice(0, source.path.search(/[*?{]/)).replace(/\/[^/]*$/, "") : source.path;
  return {
    topicSourceId: source.topicSourceId,
    topicId: source.topicId,
    kind: source.kind,
    title: source.title,
    location: source.location,
    branch: source.branch,
    path: source.path,
    credential: source.credential,
    googleAccount: source.googleAccount ? { id: source.googleAccount.googleAccountId, name: source.googleAccount.email } : null,
    // Drive's page token means nothing to show: "read".
    cursor: source.kind === "DRIVE" ? (source.cursor ? "read" : null) : (source.cursor?.slice(0, 7) ?? null),
    readAt: source.readAt?.toISOString() ?? null,
    passages,
    url:
      source.kind === "ATTACHMENT"
        ? ""
        : source.kind === "DRIVE"
          ? `https://drive.google.com/drive/folders/${source.location}`
          : `https://github.com/${source.location}${folder ? `/tree/${source.branch ?? "HEAD"}/${folder}` : ""}`,
  };
}
