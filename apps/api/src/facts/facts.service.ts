import { type Fact, type Question } from "@realentity/storm-db";
import { factKey, type FactRequest, type FactView, type QuestionView } from "@realentity/storm-shared";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * Facts about the user (M15) on the Profile page, and their answers to the questions runs ask (M15-T3): an answer becomes a
 * fact and continues the run waiting for it. Facts are written here and by the worker from the user's approvals only.
 */
@Injectable()
export class FactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<FactView[]> {
    const facts = await this.prisma.client.fact.findMany({ where: { userId }, orderBy: { question: "asc" } });
    return facts.map(factView);
  }

  async create(userId: string, request: FactRequest): Promise<FactView> {
    const key = factKey(request.question);
    if (!key) throw new BadRequestException("The question needs a word");
    if (await this.prisma.client.fact.findUnique({ where: { userId_key: { userId, key } } })) {
      throw new ConflictException(`There is a fact for "${request.question}" already: edit it`);
    }
    return factView(await this.prisma.client.fact.create({ data: { userId, key, question: request.question, answer: request.answer, source: "ME" } }));
  }

  async update(userId: string, factId: string, request: FactRequest): Promise<FactView> {
    const fact = await this.own(userId, factId);
    const key = factKey(request.question);
    const clash = await this.prisma.client.fact.findUnique({ where: { userId_key: { userId, key } } });
    if (clash && clash.factId !== fact.factId) throw new ConflictException(`There is a fact for "${request.question}" already`);
    return factView(await this.prisma.client.fact.update({ where: { factId }, data: { key, question: request.question, answer: request.answer } }));
  }

  async remove(userId: string, factId: string): Promise<void> {
    await this.own(userId, factId);
    await this.prisma.client.fact.delete({ where: { factId } });
  }

  /**
   * The user's answer to a question a run asked: kept as a fact (that question, this answer), and the run goes on. A choice
   * question takes one of its options (any case).
   */
  async answer(userId: string, questionId: string, text: string): Promise<QuestionView> {
    const question = await this.prisma.client.question.findFirst({ where: { questionId, userId } });
    if (!question) throw new NotFoundException();
    if (question.status !== "OPEN") throw new ConflictException(question.status === "ANSWERED" ? "Already answered" : "The run stopped waiting for this answer");
    const answer = question.options.length ? question.options.find((o) => o.trim().toLowerCase() === text.trim().toLowerCase()) : text.trim();
    if (answer === undefined) throw new BadRequestException(`One of: ${question.options.join(", ")}`);

    const key = factKey(question.question);
    const data = { question: question.question, answer, source: "ASKED" as const, site: question.site, runId: question.runId, proposalId: null };
    const fact = await this.prisma.client.fact.upsert({ where: { userId_key: { userId, key } }, create: { userId, key, ...data }, update: data });
    const { count } = await this.prisma.client.question.updateMany({
      where: { questionId, status: "OPEN" },
      data: { status: "ANSWERED", answer, factId: fact.factId, answeredAt: new Date() },
    });
    if (count === 0) throw new ConflictException("Already answered");
    // The worker waits on this (a takeover waiting for an answer): continued, it reads the answer.
    await this.prisma.client.takeover.updateMany({
      where: { runId: question.runId, stepKey: question.stepKey, waitsFor: "answer", status: "OPEN" },
      data: { status: "CONTINUED", resolvedAt: new Date() },
    });
    return questionView(await this.prisma.client.question.findUniqueOrThrow({ where: { questionId } }));
  }

  /** The open question a Telegram message replies to, if any. */
  questionForTelegram(userId: string, messageId: number): Promise<Question | null> {
    return this.prisma.client.question.findFirst({ where: { userId, telegramMessageId: messageId } });
  }

  private async own(userId: string, factId: string): Promise<Fact> {
    const fact = await this.prisma.client.fact.findFirst({ where: { factId, userId } });
    if (!fact) throw new NotFoundException();
    return fact;
  }
}

export function factView(fact: Fact): FactView {
  return {
    factId: fact.factId,
    question: fact.question,
    answer: fact.answer,
    source: fact.source,
    site: fact.site,
    uses: fact.uses,
    lastUsedAt: fact.lastUsedAt?.toISOString() ?? null,
    dateCreated: fact.dateCreated.toISOString(),
    dateUpdated: fact.dateUpdated.toISOString(),
  };
}

export function questionView(question: Question): QuestionView {
  return {
    questionId: question.questionId,
    question: question.question,
    options: question.options,
    site: question.site,
    stepKey: question.stepKey,
    status: question.status,
    answer: question.answer,
    dateCreated: question.dateCreated.toISOString(),
  };
}
