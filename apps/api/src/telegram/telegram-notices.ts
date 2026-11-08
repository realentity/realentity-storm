import { payloadHash } from "@realentity/storm-crypto";
import { type Prisma } from "@realentity/storm-db";
import {
  decidedMessage,
  editTelegramMessage,
  type CompiledDefinition,
  type ProposalForTelegram,
  type ServerEnv,
  type TelegramConfig,
} from "@realentity/storm-shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

/** How the api reaches the Bot API; tests replace it. */
export const TELEGRAM_FETCH = Symbol("TELEGRAM_FETCH");

export const TELEGRAM_PROPOSAL_INCLUDE = {
  run: { select: { dryRun: true, pipelineVersion: { select: { definition: true, pipeline: { select: { name: true } } } } } },
  step: { select: { type: true } },
} satisfies Prisma.ProposalInclude;

export type ProposalForBot = Prisma.ProposalGetPayload<{ include: typeof TELEGRAM_PROPOSAL_INCLUDE }>;

/** A proposal as the Storm bot shows it (M12-T4). */
export function forTelegram(proposal: ProposalForBot): ProposalForTelegram {
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
  };
}

/** The Storm bot's messages about proposals, kept in line with decisions made anywhere. */
@Injectable()
export class TelegramNotices {
  private readonly logger = new Logger(TelegramNotices.name);
  readonly config: TelegramConfig;

  constructor(
    @Inject(SERVER_ENV) env: ServerEnv,
    private readonly prisma: PrismaService,
    @Inject(TELEGRAM_FETCH) readonly send: typeof fetch,
  ) {
    this.config = { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }

  get configured(): boolean {
    return Boolean(this.config.botToken && this.config.chatId);
  }

  /** The proposal's message, if the bot sent one, says how it was decided and loses its buttons. */
  async decided(proposalId: string, outcome: string): Promise<void> {
    if (!this.configured) return;
    const proposal = await this.prisma.client.proposal.findUnique({ where: { proposalId }, include: TELEGRAM_PROPOSAL_INCLUDE });
    if (proposal?.telegramMessageId == null) return;
    await editTelegramMessage(this.config, proposal.telegramMessageId, decidedMessage(forTelegram(proposal), outcome), this.send).catch(
      (error: Error) => this.logger.warn(`Telegram message of proposal ${proposalId} not updated: ${error.message}`),
    );
  }
}
