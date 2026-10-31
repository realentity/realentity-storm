import { Prisma, type BuilderChat, type BuilderMessage } from "@ai-me/db";
import { ModelRouter, type ChatMessage, type LlmChat, type LlmUsage } from "@ai-me/llm";
import {
  definitionToSource,
  EFFORTS,
  type BuilderChatFilter,
  type BuilderChatSummaryView,
  type BuilderChatView,
  type BuilderDryRunResponse,
  type BuilderMessageRequest,
  type BuilderMessageView,
  type BuilderProposalStatus,
  type BuilderProposalView,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompileIssue,
  type EffortName,
  type ServerEnv,
} from "@ai-me/shared";
import { diffDefinitions, RecipeSchema } from "@ai-me/steps";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";
import { PipelinesService } from "../pipelines/pipelines.service";
import { RunsService } from "../runs/runs.service";
import { Builder, tokensOf, type BuilderRuns } from "./builder";
import { runData, runList } from "./run-data";

/** The builder's LLM; null without ANTHROPIC_API_KEY. */
export const BUILDER_LLM = Symbol("BUILDER_LLM");

const RECENT_CHATS = 20;
const TITLE_CHARS = 80;

/** What a proposal message stores (BuilderMessage.proposal). */
interface StoredProposal {
  status: BuilderProposalStatus;
  summary: string;
  definition: CompiledDefinition;
  policy: CompiledPolicy;
  warnings: CompileIssue[];
  savedVersion: number | null;
  /** The reflection suggestion it applies: saving it marks the suggestion done. */
  suggestionId: string | null;
}

/**
 * Builder chats (README §2.1, §2.5): a chat per new pipeline or bound to one. Each message I send runs one builder
 * turn; a proposal it makes is saved (as the next version) or dry-run only when I ask. The conversation is kept
 * exactly as the API saw it, so later turns replay it unchanged.
 */
@Injectable()
export class BuilderService {
  /** Chats with a turn in progress: one at a time per chat. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: Builder,
    private readonly router: ModelRouter,
    @Inject(BUILDER_LLM) private readonly llm: LlmChat | null,
    private readonly pipelines: PipelinesService,
    private readonly runs: RunsService,
    private readonly events: EventsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /** Recent chats about one pipeline, or (without one) about new pipelines not saved yet. */
  async list(userId: string, filter: BuilderChatFilter): Promise<BuilderChatSummaryView[]> {
    const chats = await this.prisma.client.builderChat.findMany({
      where: { userId, pipelineId: filter.pipelineId ?? null },
      include: { messages: { where: { role: "user" }, orderBy: { dateCreated: "asc" }, take: 1 } },
      orderBy: { dateUpdated: "desc" },
      take: RECENT_CHATS,
    });
    return chats.map((chat) => summary(chat, chat.messages[0]));
  }

  /** The model is chosen now (Settings, task "builder") and kept for the chat's lifetime. */
  async create(userId: string, pipelineId?: string): Promise<BuilderChatView> {
    if (pipelineId) await this.findPipeline(userId, pipelineId);
    const choice = await this.router.choose(userId, "builder");
    const chat = await this.prisma.client.builderChat.create({
      // The system prompt is kept with the chat: a later catalog change must not rewrite what earlier turns saw.
      data: { userId, pipelineId: pipelineId ?? null, model: choice.model, effort: choice.effort, system: this.builder.system },
    });
    return this.get(userId, chat.builderChatId);
  }

  async get(userId: string, chatId: string): Promise<BuilderChatView> {
    const chat = await this.findChat(userId, chatId);
    const [messages, pipeline, suggestions] = await Promise.all([
      this.prisma.client.builderMessage.findMany({ where: { builderChatId: chatId }, orderBy: { dateCreated: "asc" } }),
      chat.pipelineId ? this.prisma.client.pipeline.findUnique({ where: { pipelineId: chat.pipelineId } }) : null,
      chat.pipelineId
        ? this.prisma.client.pipelineSuggestion.findMany({
            where: { userId, pipelineId: chat.pipelineId, status: "OPEN" },
            orderBy: { dateCreated: "desc" },
          })
        : [],
    ]);
    const version = await this.currentVersion(chat.pipelineId);
    const current = (version?.definition as unknown as CompiledDefinition | undefined) ?? null;
    return {
      ...summary(
        chat,
        messages.find((m) => m.role === "user"),
      ),
      pipelineName: pipeline?.name ?? null,
      currentVersion: version?.version ?? null,
      tokensUsed: chat.tokensUsed,
      tokenCap: this.env.BUILDER_CHAT_MAX_TOKENS,
      costUsd: round(messages.reduce((sum, m) => sum + (usageOf(m)?.costUsd ?? 0), 0)),
      messages: messages.map((m) => messageView(m, current)),
      suggestions: suggestions.map((s) => ({
        suggestionId: s.suggestionId,
        pipelineId: s.pipelineId,
        pipelineName: pipeline?.name ?? "",
        text: s.text,
        rationale: s.rationale,
        status: s.status,
        dateCreated: s.dateCreated.toISOString(),
      })),
      available: this.llm !== null,
    };
  }

  /** One builder turn: my message, the builder's answer (and proposal, if it made one). */
  async send(userId: string, chatId: string, body: BuilderMessageRequest): Promise<BuilderChatView> {
    if (!this.llm) throw new ServiceUnavailableException("The builder needs ANTHROPIC_API_KEY");
    const chat = await this.findChat(userId, chatId);
    if (chat.tokensUsed >= this.env.BUILDER_CHAT_MAX_TOKENS) {
      throw new ConflictException("This chat reached its token limit. Start a new chat to continue.");
    }
    if (this.busy.has(chatId)) throw new ConflictException("The builder is still answering the previous message");
    this.busy.add(chatId);
    try {
      return await this.turn(userId, chat, body);
    } finally {
      this.busy.delete(chatId);
    }
  }

  /** Saves a proposal as the pipeline's next version (or v1 of a new pipeline, which the chat then belongs to). */
  async save(userId: string, chatId: string, messageId: string): Promise<BuilderChatView> {
    const chat = await this.findChat(userId, chatId);
    const { message, proposal } = await this.openProposal(chatId, messageId);
    const source = definitionToSource(proposal.definition);
    const pipeline = chat.pipelineId
      ? await this.pipelines.addVersion(userId, chat.pipelineId, source, chatId)
      : await this.pipelines.create(userId, source, chatId);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.builderMessage.update({
        where: { builderMessageId: message.builderMessageId },
        data: { proposal: json({ ...proposal, status: "saved", savedVersion: pipeline.currentVersion }) },
      });
      if (!chat.pipelineId) await tx.builderChat.update({ where: { builderChatId: chatId }, data: { pipelineId: pipeline.pipelineId } });
      if (proposal.suggestionId) {
        await tx.pipelineSuggestion.updateMany({ where: { suggestionId: proposal.suggestionId, userId }, data: { status: "DONE" } });
      }
    });
    await this.changed(userId, chatId, proposal.suggestionId !== null);
    return this.get(userId, chatId);
  }

  /** A dry run of a proposal: it becomes the pipeline's draft (a new pipeline gets one, and the chat with it). */
  async dryRun(userId: string, chatId: string, messageId: string): Promise<BuilderDryRunResponse> {
    const chat = await this.findChat(userId, chatId);
    const { proposal } = await this.openProposal(chatId, messageId);
    const { pipeline, run } = await this.pipelines.dryRun(userId, definitionToSource(proposal.definition), chat.pipelineId ?? undefined);
    if (!chat.pipelineId) {
      await this.prisma.client.builderChat.update({ where: { builderChatId: chatId }, data: { pipelineId: pipeline.pipelineId } });
    }
    await this.changed(userId, chatId, false);
    return { chat: await this.get(userId, chatId), run };
  }

  private async turn(userId: string, chat: BuilderChat, body: BuilderMessageRequest): Promise<BuilderChatView> {
    const suggestion = body.suggestionId ? await this.openSuggestion(userId, chat, body.suggestionId) : null;
    const earlier = await this.prisma.client.builderMessage.findMany({
      where: { builderChatId: chat.builderChatId },
      orderBy: { dateCreated: "asc" },
    });
    const history = earlier.flatMap((m) => (m.transcript as ChatMessage[] | null) ?? []);
    const current = await this.currentVersion(chat.pipelineId);

    // What the builder sees: the current version when it hasn't seen it yet, a suggestion to apply, my message.
    const parts: string[] = [];
    if (current && !history.some((m) => m.role === "user" && JSON.stringify(m.content).includes(current.pipelineVersionId))) {
      const definition = current.definition as unknown as CompiledDefinition;
      parts.push(
        `<current_pipeline version="${current.version}" id="${current.pipelineVersionId}">\n${definitionToSource(definition)}</current_pipeline>`,
      );
    }
    const recipes = await this.recipesBlock(userId);
    if (recipes !== lastShown(history, "saved_recipes")) parts.push(recipes);
    if (suggestion) {
      parts.push(
        `<reflection_suggestion>\n${suggestion.text}${suggestion.rationale ? `\nWhy: ${suggestion.rationale}` : ""}\n</reflection_suggestion>`,
      );
    }
    parts.push(body.text);
    const user: ChatMessage = { role: "user", content: [{ type: "text", text: parts.join("\n\n") }] };

    const result = await this.builder.turn({
      choice: { model: chat.model, effort: (EFFORTS as readonly string[]).includes(chat.effort) ? (chat.effort as EffortName) : "high" },
      history,
      user,
      current: (current?.definition as unknown as CompiledDefinition | undefined) ?? null,
      runs: chat.pipelineId ? this.runsOf(userId, chat.pipelineId) : null,
      system: chat.system ?? undefined,
      tokensLeft: this.env.BUILDER_CHAT_MAX_TOKENS - chat.tokensUsed,
    });

    const proposal: StoredProposal | null = result.proposal && {
      status: "open",
      summary: result.proposal.summary,
      definition: result.proposal.compiled.definition,
      policy: result.proposal.compiled.policy,
      warnings: result.proposal.compiled.warnings,
      savedVersion: null,
      suggestionId: suggestion?.suggestionId ?? null,
    };
    const ok = result.transcript !== null;
    await this.prisma.client.$transaction(async (tx) => {
      if (proposal) await this.supersede(tx, chat.builderChatId);
      const now = Date.now();
      await tx.builderMessage.create({
        data: {
          builderChatId: chat.builderChatId,
          role: "user",
          text: body.text,
          transcript: ok ? json([user]) : Prisma.DbNull,
          suggestionId: suggestion?.suggestionId ?? null,
          dateCreated: new Date(now),
        },
      });
      await tx.builderMessage.create({
        data: {
          builderChatId: chat.builderChatId,
          role: "assistant",
          text: result.text,
          transcript: ok ? json(result.transcript) : Prisma.DbNull,
          proposal: proposal ? json(proposal) : Prisma.DbNull,
          compileErrors: result.compileErrors ? json(result.compileErrors) : Prisma.DbNull,
          error: result.error,
          llmUsage: json(result.usage),
          // After my message, whatever the clock resolution.
          dateCreated: new Date(now + 1),
        },
      });
      await tx.builderChat.update({
        where: { builderChatId: chat.builderChatId },
        data: { tokensUsed: { increment: tokensOf(result.usage) } },
      });
    });
    await this.changed(userId, chat.builderChatId, false);
    return this.get(userId, chat.builderChatId);
  }

  /** A newer proposal replaces the open ones before it. */
  private async supersede(tx: Prisma.TransactionClient, chatId: string): Promise<void> {
    const open = await tx.builderMessage.findMany({
      where: { builderChatId: chatId, role: "assistant", proposal: { not: Prisma.DbNull } },
    });
    for (const message of open) {
      const proposal = message.proposal as unknown as StoredProposal;
      if (proposal.status !== "open") continue;
      await tx.builderMessage.update({
        where: { builderMessageId: message.builderMessageId },
        data: { proposal: json({ ...proposal, status: "superseded" }) },
      });
    }
  }

  private runsOf(userId: string, pipelineId: string): BuilderRuns {
    return {
      list: async (limit) => runList(await this.runs.list(userId, { pipelineId, limit })),
      read: async (runId, stepKey) => {
        if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
        const run = await this.runs.get(userId, runId).catch((error: unknown) => {
          if (error instanceof NotFoundException) return null;
          throw error;
        });
        return run && run.pipelineId === pipelineId ? runData(run, stepKey) : null;
      },
    };
  }

  private async openProposal(chatId: string, messageId: string): Promise<{ message: BuilderMessage; proposal: StoredProposal }> {
    const message = await this.prisma.client.builderMessage.findFirst({ where: { builderMessageId: messageId, builderChatId: chatId } });
    const proposal = message?.proposal as unknown as StoredProposal | null | undefined;
    if (!message || !proposal) throw new NotFoundException();
    if (proposal.status !== "open") throw new ConflictException(`This proposal was ${proposal.status}`);
    return { message, proposal };
  }

  private async openSuggestion(userId: string, chat: BuilderChat, suggestionId: string) {
    const suggestion = await this.prisma.client.pipelineSuggestion.findFirst({
      where: { suggestionId, userId, pipelineId: chat.pipelineId ?? undefined, status: "OPEN" },
    });
    if (!suggestion || !chat.pipelineId) {
      throw new BadRequestException({
        message: "No such open suggestion for this pipeline",
        errors: [{ path: "suggestionId", message: "not found" }],
      });
    }
    return suggestion;
  }

  private async findChat(userId: string, chatId: string): Promise<BuilderChat> {
    const chat = await this.prisma.client.builderChat.findFirst({ where: { builderChatId: chatId, userId } });
    if (!chat) throw new NotFoundException();
    return chat;
  }

  private async findPipeline(userId: string, pipelineId: string): Promise<void> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline) throw new NotFoundException();
  }

  /** The recipes browser.extract can use (latest versions), as the builder sees them in my message. */
  private async recipesBlock(userId: string): Promise<string> {
    const rows = await this.prisma.client.siteRecipe.findMany({ where: { userId }, orderBy: [{ name: "asc" }, { version: "desc" }] });
    const lines: string[] = [];
    for (const row of rows) {
      if (lines.some((line) => line.startsWith(`- ${row.name} `))) continue;
      const parsed = RecipeSchema.safeParse(row.steps);
      const params = parsed.success
        ? Object.entries(parsed.data.params).map(([name, p]) => `${name}${p.description ? ` (${p.description})` : ""}`)
        : [];
      lines.push(`- ${row.name} v${row.version}: params ${params.join(", ") || "none"}${row.brokenAt ? "; broken: needs teaching again" : ""}`);
    }
    return `<saved_recipes>\n${lines.length > 0 ? lines.join("\n") : "none yet"}\n</saved_recipes>`;
  }

  private async currentVersion(pipelineId: string | null) {
    if (!pipelineId) return null;
    const pipeline = await this.prisma.client.pipeline.findUnique({ where: { pipelineId }, select: { currentVersionId: true } });
    if (!pipeline?.currentVersionId) return null;
    return this.prisma.client.pipelineVersion.findUnique({ where: { pipelineVersionId: pipeline.currentVersionId } });
  }

  private async changed(userId: string, chatId: string, learning: boolean): Promise<void> {
    await this.events.publish(userId, { type: "builder", chatId });
    if (learning) await this.events.publish(userId, { type: "learning" });
  }
}

/** The last <tag> block my messages showed the builder, or null: shown again only when it changed. */
function lastShown(history: ChatMessage[], tag: string): string | null {
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
  let last: string | null = null;
  for (const message of history) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") for (const match of block.text.matchAll(pattern)) last = match[0];
    }
  }
  return last;
}

function summary(chat: BuilderChat, first: BuilderMessage | undefined): BuilderChatSummaryView {
  const title = first?.text.replace(/\s+/g, " ").trim() ?? "";
  return {
    chatId: chat.builderChatId,
    pipelineId: chat.pipelineId,
    title: title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title || "New chat",
    model: chat.model,
    dateCreated: chat.dateCreated.toISOString(),
    dateUpdated: chat.dateUpdated.toISOString(),
  };
}

function messageView(message: BuilderMessage, current: CompiledDefinition | null): BuilderMessageView {
  const stored = message.proposal as unknown as StoredProposal | null;
  const proposal: BuilderProposalView | null = stored && {
    status: stored.status,
    summary: stored.summary,
    source: definitionToSource(stored.definition),
    definition: stored.definition,
    policy: stored.policy,
    warnings: stored.warnings,
    // Against the current version as it is now: another version may have been saved since.
    diff: stored.status === "open" && current ? diffDefinitions(current, stored.definition) : null,
    savedVersion: stored.savedVersion,
  };
  return {
    messageId: message.builderMessageId,
    role: message.role === "user" ? "user" : "assistant",
    text: message.text,
    proposal,
    compileErrors: (message.compileErrors as CompileIssue[] | null) ?? null,
    error: message.error,
    costUsd: usageOf(message)?.costUsd ?? null,
    dateCreated: message.dateCreated.toISOString(),
  };
}

function usageOf(message: BuilderMessage): LlmUsage | null {
  return (message.llmUsage as LlmUsage | null) ?? null;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function round(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
