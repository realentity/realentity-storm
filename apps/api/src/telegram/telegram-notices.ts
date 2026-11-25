import { payloadHash } from "@realentity/storm-crypto";
import { emailSenders, Integrations, stepTypeIn, type Prisma, type PrismaClient } from "@realentity/storm-db";
import {
  decidedMessage,
  editTelegramMessage,
  telegramReady,
  type CompiledDefinition,
  type ProposalForTelegram,
  type TelegramLookup,
} from "@realentity/storm-shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/** How the api reaches the Bot API; tests replace it. */
export const TELEGRAM_FETCH = Symbol("TELEGRAM_FETCH");

export const TELEGRAM_PROPOSAL_INCLUDE = {
  run: {
    select: { dryRun: true, pipelineVersion: { select: { pipelineId: true, definition: true, pipeline: { select: { name: true } } } } },
  },
  step: { select: { type: true } },
} satisfies Prisma.ProposalInclude;

export type ProposalForBot = Prisma.ProposalGetPayload<{ include: typeof TELEGRAM_PROPOSAL_INCLUDE }>;

type Sender = ProposalForTelegram["from"];

/** Whom each of these that is an email goes out from (by proposal); the others aren't in it. */
export async function telegramSenders(prisma: PrismaClient, proposals: readonly ProposalForBot[]): Promise<Map<string, Sender>> {
  const senders = new Map<string, Sender>();
  for (const userId of new Set(proposals.map((p) => p.userId))) {
    const emails = proposals
      .filter((p) => p.userId === userId && stepTypeIn(p.run.pipelineVersion.definition, p.stepKey) === "email.send")
      .map((p) => ({
        key: p.proposalId,
        pipelineId: p.run.pipelineVersion.pipelineId,
        definition: p.run.pipelineVersion.definition,
        payload: p.originalPayload as Record<string, unknown>,
      }));
    for (const [key, sender] of await emailSenders(prisma, userId, emails)) senders.set(key, sender);
  }
  return senders;
}

/** A proposal as the Storm bot shows it (M12-T4); an email with whom it goes from (`senders`, telegramSenders). */
export function forTelegram(proposal: ProposalForBot, senders?: ReadonlyMap<string, Sender>): ProposalForTelegram {
  const payload = proposal.originalPayload as Record<string, unknown>;
  const definition = proposal.run.pipelineVersion.definition as unknown as CompiledDefinition;
  return {
    proposalId: proposal.proposalId,
    pipeline: proposal.run.pipelineVersion.pipeline.name,
    gate: proposal.step.type === "gate.review" ? "gate.review" : "gate.act",
    stepType: definition.steps.find((s) => s.id === proposal.stepKey)?.type ?? proposal.stepKey,
    target: proposal.target,
    itemIndex: proposal.itemIndex,
    payload,
    payloadHash: payloadHash(payload),
    ...(senders?.has(proposal.proposalId) ? { from: senders.get(proposal.proposalId) } : {}),
  };
}

/** The Storm bot's messages about proposals, kept in line with decisions made anywhere. */
@Injectable()
export class TelegramNotices {
  private readonly logger = new Logger(TelegramNotices.name);
  /** M63: the bot as saved in Settings → Telegram, looked up at each call. */
  readonly config: TelegramLookup;

  constructor(
    private readonly prisma: PrismaService,
    integrations: Integrations,
    @Inject(TELEGRAM_FETCH) readonly send: typeof fetch,
  ) {
    this.config = () => integrations.telegram();
  }

  /** The bot is set up and on. */
  configured(): Promise<boolean> {
    return telegramReady(this.config);
  }

  /** The proposal's message, if the bot sent one, says how it was decided and loses its buttons. */
  async decided(proposalId: string, outcome: string): Promise<void> {
    if (!(await this.configured())) return;
    const proposal = await this.prisma.client.proposal.findUnique({ where: { proposalId }, include: TELEGRAM_PROPOSAL_INCLUDE });
    if (proposal?.telegramMessageId == null) return;
    // M53: a batch's message stays: its Approve all refuses now that the batch changed, and says to open the inbox.
    const sharing = await this.prisma.client.proposal.count({
      where: { runId: proposal.runId, telegramMessageId: proposal.telegramMessageId },
    });
    if (sharing > 1) return;
    await editTelegramMessage(
      this.config,
      proposal.telegramMessageId,
      decidedMessage(forTelegram(proposal, await telegramSenders(this.prisma.client, [proposal])), outcome),
      this.send,
    ).catch((error: Error) => this.logger.warn(`Telegram message of proposal ${proposalId} not updated: ${error.message}`));
  }

  /** M53: a batch decided at once: each message it was told in says so once ("✅ 23 approved, ✖ 2 rejected in Telegram"). */
  async decidedBatch(proposalIds: readonly string[], approved: ReadonlySet<string>, via: string): Promise<void> {
    if (!(await this.configured())) return;
    const proposals = await this.prisma.client.proposal.findMany({
      where: { proposalId: { in: [...proposalIds] } },
      include: TELEGRAM_PROPOSAL_INCLUDE,
    });
    const byMessage = new Map<number, typeof proposals>();
    for (const p of proposals)
      if (p.telegramMessageId != null) byMessage.set(p.telegramMessageId, [...(byMessage.get(p.telegramMessageId) ?? []), p]);
    for (const [messageId, group] of byMessage) {
      if (group.length === 1) {
        await this.decided(group[0].proposalId, approved.has(group[0].proposalId) ? `✅ Approved in ${via}` : `✖ Rejected in ${via}`);
        continue;
      }
      const yes = group.filter((p) => approved.has(p.proposalId)).length;
      const outcome = [yes && `✅ ${yes} approved`, group.length - yes && `✖ ${group.length - yes} rejected`].filter(Boolean).join(", ");
      const pipeline = group[0].run.pipelineVersion.pipeline.name;
      await editTelegramMessage(
        this.config,
        messageId,
        {
          text: `${outcome} in ${via}

Storm · ${pipeline}: ${group.length} × ${group[0].stepKey}`,
          buttons: [],
        },
        this.send,
      ).catch((error: Error) => this.logger.warn(`Telegram message of a batch not updated: ${error.message}`));
    }
  }
}
