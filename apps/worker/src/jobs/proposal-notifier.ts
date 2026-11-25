import { batchHash, payloadHash } from "@realentity/storm-crypto";
import { emailSenders, stepTypeIn, type PrismaClient } from "@realentity/storm-db";
import {
  batchMessage,
  proposalMessage,
  sendTelegramMessage,
  type CompiledDefinition,
  type ProposalForTelegram,
  telegramConfig,
  type TelegramSource,
} from "@realentity/storm-shared";
import { Logger } from "@nestjs/common";

/** More messages than this at once (proposals of several steps) get one message, not one each. */
const ONE_BY_ONE = 5;

/**
 * Tells the user on the Storm bot what a run waits for (M12-T4): each new proposal with Approve / Reject / Open, or one
 * message when a gate made many. Each proposal is told once (Proposal.notifiedAt); dry runs aren't told.
 */
export class ProposalNotifier {
  private readonly logger = new Logger(ProposalNotifier.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegram: TelegramSource,
    private readonly appOrigin?: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  async waiting(runId: string): Promise<void> {
    const ready = await telegramConfig(this.telegram);
    if (!ready.botToken || !ready.chatId) return;
    const run = await this.prisma.run.findUniqueOrThrow({
      where: { runId },
      include: { pipelineVersion: { include: { pipeline: true } } },
    });
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
    // M53-T3: an act step's proposals of this run (a forEach's items) are one message, approved all at once.
    const byStep = new Map<string, typeof fresh>();
    for (const p of fresh) byStep.set(p.stepKey, [...(byStep.get(p.stepKey) ?? []), p]);
    const batches = [...byStep.values()].filter((group) => group.length > 1 && group[0].step.type === "gate.act");
    const alone = fresh.filter((p) => !batches.some((group) => group.includes(p)));
    try {
      if (batches.length + alone.length > ONE_BY_ONE) {
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
      // An email says whom it goes from (the account the send will use), not its account's id.
      const senders = await emailSenders(
        this.prisma,
        run.userId,
        fresh
          .filter((p) => stepTypeIn(definition, p.stepKey) === "email.send")
          .map((p) => ({
            key: p.proposalId,
            pipelineId: run.pipelineVersion.pipelineId,
            definition,
            payload: p.originalPayload as Record<string, unknown>,
          })),
      );
      const approvals = settings?.telegramApprovals ?? true;
      for (const group of batches) {
        // Every proposal pending at this step, not only the new ones: Approve all decides the step's whole batch.
        const pending = await this.prisma.proposal.findMany({
          where: { runId, stepKey: group[0].stepKey, status: "PENDING_REVIEW" },
          orderBy: { itemIndex: "asc" },
        });
        const message = batchMessage(
          {
            runId,
            pipeline,
            stepType: stepTypeIn(definition, group[0].stepKey) ?? group[0].stepKey,
            items: pending.map((p) => ({
              itemIndex: p.itemIndex,
              target: p.target,
              payload: p.originalPayload as Record<string, unknown>,
            })),
            hash: batchHash(pending.map((p) => p.proposalId)),
          },
          { approvals, appOrigin: this.appOrigin },
        );
        const messageId = await sendTelegramMessage(this.telegram, message, this.send);
        await this.prisma.proposal.updateMany({
          where: { proposalId: { in: pending.map((p) => p.proposalId) } },
          data: { telegramMessageId: messageId },
        });
      }
      for (const proposal of alone) {
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
          ...(senders.has(proposal.proposalId) ? { from: senders.get(proposal.proposalId) } : {}),
        };
        const message = proposalMessage(shown, { approvals, appOrigin: this.appOrigin });
        const messageId = await sendTelegramMessage(this.telegram, message, this.send);
        await this.prisma.proposal.update({ where: { proposalId: proposal.proposalId }, data: { telegramMessageId: messageId } });
      }
    } catch (error) {
      // The inbox still has them; a lost message isn't worth failing the run's job.
      this.logger.warn(`Proposals of run ${runId} not told on Telegram: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
