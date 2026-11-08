import { type BuilderChatView, type BuilderMessageView, type CompiledDefinition, type ServerEnv, type TelegramMessage, TELEGRAM_MAX_TEXT, type Trigger } from "@realentity/storm-shared";
import { Inject, Injectable } from "@nestjs/common";
import { BuilderService } from "../builder/builder.service";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { PipelinesService } from "../pipelines/pipelines.service";

/** The Telegram chat goes on while the user is on it; after this long without a message, the next one starts a new chat. */
export const TELEGRAM_CHAT_IDLE_MS = 2 * 60 * 60 * 1000;

/** A builder button: save or dry-run a proposal (its message id), turn a pipeline on (its id). */
export type BuilderCallback = { action: "save" | "dryRun"; messageId: string } | { action: "turnOn"; pipelineId: string };

const CALLBACK = /^b([sdo]):([0-9a-f-]{36})$/;

export function parseBuilderCallback(data: string): BuilderCallback | null {
  const match = CALLBACK.exec(data);
  if (!match) return null;
  const [, kind, id] = match as unknown as [string, "s" | "d" | "o", string];
  return kind === "o" ? { action: "turnOn", pipelineId: id } : { action: kind === "s" ? "save" : "dryRun", messageId: id };
}

/**
 * The pipeline builder on the Storm bot (M21): a plain message is the user's next turn in the Telegram chat, the answer and
 * its proposal come back as a message with Save, Dry run and Open. Saving and dry runs go through BuilderService,
 * exactly as on the Builder page; a saved pipeline starts disabled until the user presses Turn on.
 */
@Injectable()
export class TelegramBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: BuilderService,
    private readonly pipelines: PipelinesService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /** A message to the builder: the answer as a Telegram message. Throws what the builder refused (busy, no key, cap). */
  async talk(userId: string, text: string, now = new Date()): Promise<TelegramMessage> {
    const chatId = await this.chatFor(userId, now);
    const chat = await this.builder.send(userId, chatId, { text });
    const answer = chat.messages.at(-1);
    if (!answer || answer.role !== "assistant") throw new Error("The builder gave no answer");
    return this.answer(chat, answer);
  }

  /** /new: the next message starts a new chat. */
  async forget(userId: string): Promise<void> {
    await this.prisma.client.userSetting.upsert({ where: { userId }, create: { userId }, update: { telegramBuilderChatId: null } });
  }

  /** /edit <pipeline>: a new chat about that pipeline. */
  async edit(userId: string, pipelineId: string): Promise<BuilderChatView> {
    const chat = await this.builder.create(userId, pipelineId);
    await this.remember(userId, chat.chatId);
    return chat;
  }

  async press(userId: string, callback: BuilderCallback): Promise<{ answer: string; message?: TelegramMessage }> {
    if (callback.action === "turnOn") {
      const pipeline = await this.pipelines.update(userId, callback.pipelineId, { enabled: true });
      return { answer: "Turned on", message: { text: `${pipeline.name} is on: it runs on its trigger.`, buttons: this.open(`/pipelines/${pipeline.pipelineId}`, "Open the pipeline") } };
    }
    const message = await this.prisma.client.builderMessage.findFirst({
      where: { builderMessageId: callback.messageId, chat: { userId } },
      select: { builderChatId: true },
    });
    if (!message) return { answer: "That proposal is gone" };
    if (callback.action === "dryRun") {
      const { chat, run } = await this.builder.dryRun(userId, message.builderChatId, callback.messageId);
      return {
        answer: "Dry run started",
        message: {
          text: `Dry run of ${chat.pipelineName ?? "the proposal"} started: nothing is sent, the gates only show what would be.`,
          buttons: this.open(`/runs/${run.runId}`, "Open the run"),
        },
      };
    }
    const chat = await this.builder.save(userId, message.builderChatId, callback.messageId);
    const pipeline = await this.pipelines.get(userId, chat.pipelineId!);
    const trigger = pipeline.current?.definition.trigger ?? "manual";
    const turnOn = !pipeline.enabled && trigger !== "manual";
    return {
      answer: "Saved",
      message: {
        text: `Saved: ${pipeline.name} v${pipeline.currentVersion}. ${
          turnOn ? `It is off: Turn on to run it ${triggerText(trigger)}.` : pipeline.enabled ? "It is on." : "Start it with /run."
        }`,
        buttons: [
          ...(turnOn ? [[{ text: "Turn on", data: `bo:${pipeline.pipelineId}` }]] : []),
          ...(this.open(`/pipelines/${pipeline.pipelineId}`, "Open the pipeline") ?? []),
        ],
      },
    };
  }

  /** The Telegram chat if the user is still on it (and it has tokens left), else a new one. */
  private async chatFor(userId: string, now: Date): Promise<string> {
    const settings = await this.prisma.client.userSetting.findUnique({ where: { userId }, select: { telegramBuilderChatId: true } });
    const id = settings?.telegramBuilderChatId;
    const chat = id ? await this.prisma.client.builderChat.findFirst({ where: { builderChatId: id, userId } }) : null;
    if (chat && now.getTime() - chat.dateUpdated.getTime() < TELEGRAM_CHAT_IDLE_MS && chat.tokensUsed < this.env.BUILDER_CHAT_MAX_TOKENS) {
      return chat.builderChatId;
    }
    const created = await this.builder.create(userId);
    await this.remember(userId, created.chatId);
    return created.chatId;
  }

  private async remember(userId: string, chatId: string): Promise<void> {
    await this.prisma.client.userSetting.upsert({
      where: { userId },
      create: { userId, telegramBuilderChatId: chatId },
      update: { telegramBuilderChatId: chatId },
    });
  }

  private answer(chat: BuilderChatView, message: BuilderMessageView): TelegramMessage {
    const parts: string[] = [];
    if (message.error) parts.push(`The builder failed: ${message.error}`);
    if (message.text.trim()) parts.push(message.text.trim());
    if (message.compileErrors?.length) {
      parts.push(`Its last attempt didn't compile:\n${message.compileErrors.map((e) => `• ${e.path ? `${e.path}: ` : ""}${e.message}`).join("\n")}`);
    }
    const proposal = message.proposal;
    if (proposal) parts.push(proposalText(proposal.summary, proposal.definition, proposal.warnings.map((w) => w.message)));
    const footer = "\n\n(/new starts over)";
    let text = parts.join("\n\n") || "(no answer)";
    if (text.length + footer.length > TELEGRAM_MAX_TEXT) text = `${text.slice(0, TELEGRAM_MAX_TEXT - footer.length - 1)}…`;
    return {
      text: text + footer,
      buttons: [
        ...(proposal?.status === "open"
          ? [
              [
                { text: chat.pipelineId && chat.currentVersion ? `Save as v${chat.currentVersion + 1}` : "Save", data: `bs:${message.messageId}` },
                { text: "Dry run", data: `bd:${message.messageId}` },
              ],
            ]
          : []),
        ...(this.open(`/builder/${chat.chatId}`, "Open in Storm") ?? []),
      ],
    };
  }

  private open(path: string, text: string): TelegramMessage["buttons"] {
    return this.env.APP_ORIGIN ? [[{ text, url: `${this.env.APP_ORIGIN}${path}` }]] : undefined;
  }
}

/** A proposal in a few lines: what it does, when, its steps (gates marked), the compiler's warnings. */
export function proposalText(summary: string, definition: CompiledDefinition, warnings: string[]): string {
  const steps = definition.steps.map((step, i) => {
    const note = step.autoInserted ? " (added: waits for your approval)" : step.forEach ? " (for each item)" : "";
    return `${i + 1}. ${step.id}: ${step.type}${note}`;
  });
  return [
    `Proposal: ${summary}`,
    `${definition.name}, ${triggerText(definition.trigger)}`,
    ...steps,
    ...(warnings.length ? ["Warnings:", ...warnings.map((w) => `• ${w}`)] : []),
  ].join("\n");
}

function triggerText(trigger: Trigger): string {
  if (trigger === "manual") return "started by hand";
  if ("schedule" in trigger) return `on the schedule ${trigger.schedule}${trigger.tz ? ` (${trigger.tz})` : ""}`;
  if ("on" in trigger) return `when ${String(trigger.on)} happens`;
  return "when its webhook is called";
}
