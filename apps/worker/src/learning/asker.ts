import { type PrismaClient } from "@realentity/storm-db";
import { sendTelegramMessage, type TelegramConfig } from "@realentity/storm-shared";
import { Logger } from "@nestjs/common";
import { RunStopped, type StepContext } from "../runner/step-executor";

export interface Ask {
  question: string;
  /** A select's or radio's choices. */
  options?: string[];
  /** The site whose form asks it. */
  site?: string | null;
}

/**
 * Asking me what neither my profile nor my facts answer (M15-T3): on Telegram (a reply to the message answers it)
 * and on the run page. The run waits like for a takeover (the api continues it with my answer, which it also saves
 * as a fact); nobody answering within the takeover timeout leaves the field empty for the gate.
 */
export class Asker {
  private readonly logger = new Logger(Asker.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegram: TelegramConfig,
    private readonly appOrigin?: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  /** My answer and the fact it became, or null when I didn't answer in time (or continued without one). */
  async ask(context: StepContext, ask: Ask): Promise<{ answer: string; factId: string | null } | null> {
    const row = await this.prisma.question.create({
      data: {
        userId: context.userId,
        runId: context.runId,
        stepKey: context.stepKey,
        itemIndex: context.itemIndex,
        question: ask.question,
        options: ask.options ?? [],
        site: ask.site ?? null,
      },
    });
    await this.tell(row.questionId, context.runId, ask);
    try {
      await context.attention.needMe(`A question for you: ${ask.question}`, undefined, { waitsFor: "answer", notify: false });
    } catch (error) {
      if (error instanceof RunStopped) throw error;
      // No answer within the timeout (or no live run to wait in): the field stays empty, the gate shows it.
      await this.prisma.question.updateMany({ where: { questionId: row.questionId, status: "OPEN" }, data: { status: "EXPIRED" } });
      return null;
    }
    const answered = await this.prisma.question.findUniqueOrThrow({ where: { questionId: row.questionId } });
    if (answered.status !== "ANSWERED") await this.prisma.question.updateMany({ where: { questionId: row.questionId, status: "OPEN" }, data: { status: "EXPIRED" } });
    return answered.status === "ANSWERED" && answered.answer ? { answer: answered.answer, factId: answered.factId } : null;
  }

  private async tell(questionId: string, runId: string, ask: Ask): Promise<void> {
    if (!this.telegram.botToken || !this.telegram.chatId) return;
    const text = [
      `Storm asks${ask.site ? ` (a form on ${ask.site})` : ""}: ${ask.question}`,
      ask.options?.length ? `One of: ${ask.options.join(" · ")}` : "",
      "Reply to this message with your answer. It's kept as a fact, so the next form won't ask again.",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const messageId = await sendTelegramMessage(
        this.telegram,
        { text, buttons: this.appOrigin ? [[{ text: "Answer on Storm", url: `${this.appOrigin}/runs/${runId}` }]] : [] },
        this.send,
      );
      await this.prisma.question.update({ where: { questionId }, data: { telegramMessageId: messageId } });
    } catch (error) {
      this.logger.warn(`Question not sent on Telegram: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
