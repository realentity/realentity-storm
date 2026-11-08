import { payloadHash } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";
import {
  proposalMessage,
  sendTelegramMessage,
  type CompiledDefinition,
  type ProposalForTelegram,
  type TelegramConfig,
} from "@realentity/storm-shared";
import { Logger } from "@nestjs/common";

/** More new proposals than this at once (a long shortlist) get one message, not one each. */
const ONE_BY_ONE = 5;

/**
 * Tells the user on the Storm bot what a run waits for (M12-T4): each new proposal with Approve / Reject / Open, or one
 * message when a gate made many. Each proposal is told once (Proposal.notifiedAt); dry runs aren't told.
 */
export class ProposalNotifier {
  private readonly logger = new Logger(ProposalNotifier.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegram: TelegramConfig,
    private readonly appOrigin?: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  async waiting(runId: string): Promise<void> {
    if (!this.telegram.botToken || !this.telegram.chatId) return;
    const run = await this.prisma.run.findUniqueOrThrow({ where: { runId }, include: { pipelineVersion: { include: { pipeline: true } } } });
    if (run.dryRun) return;
    const fresh = await this.prisma.proposal.findMany({
      where: { runId, status: "PENDING_REVIEW", notifiedAt: null },
      include: { step: { select: { type: true } } },
      orderBy: [{ dateCreated: "asc" }, { itemIndex: "asc" }],
    });
    // Claimed first: a second advance of the same run tells nothing twice.
    const claimed = await this.prisma.proposal.updateMany({
      where: { proposalId: { in: fresh.map((p) => p.proposalId) }, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (claimed.count === 0) return;
    const pipeline = run.pipelineVersion.pipeline.name;
    try {
      if (fresh.length > ONE_BY_ONE) {
        await sendTelegramMessage(
          this.telegram,
          {
            text: `Storm · ${pipeline}: ${fresh.length} proposals wait for you.`,
            buttons: this.appOrigin ? [[{ text: "Open the inbox", url: `${this.appOrigin}/inbox` }]] : [],
          },
          this.send,
        );
        return;
      }
      const settings = await this.prisma.userSetting.findUnique({ where: { userId: run.userId } });
      const definition = run.pipelineVersion.definition as unknown as CompiledDefinition;
      for (const proposal of fresh) {
        const payload = proposal.originalPayload as Record<string, unknown>;
        const shown: ProposalForTelegram = {
          proposalId: proposal.proposalId,
          pipeline,
          gate: proposal.step.type === "gate.review" ? "gate.review" : "gate.act",
          stepType: definition.steps.find((s) => s.id === proposal.stepKey)?.type ?? proposal.stepKey,
          target: proposal.target,
          itemIndex: proposal.itemIndex,
          payload,
          payloadHash: payloadHash(payload),
        };
        const message = proposalMessage(shown, { approvals: settings?.telegramApprovals ?? true, appOrigin: this.appOrigin });
        const messageId = await sendTelegramMessage(this.telegram, message, this.send);
        await this.prisma.proposal.update({ where: { proposalId: proposal.proposalId }, data: { telegramMessageId: messageId } });
      }
    } catch (error) {
      // The inbox still has them; a lost message isn't worth failing the run's job.
      this.logger.warn(`Proposals of run ${runId} not told on Telegram: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
