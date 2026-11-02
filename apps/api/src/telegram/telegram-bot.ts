import {
  answerTelegramCallback,
  decidedMessage,
  editTelegramMessage,
  hashMatches,
  parseProposalCallback,
  proposalMessage,
  sendTelegramMessage,
  sendTelegramTyping,
  type ServerEnv,
  type TargetView,
  type TelegramMessage,
} from "@ai-me/shared";
import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { SERVER_ENV } from "../config/server-env";
import { ControlsService } from "../controls/controls.service";
import { PrismaService } from "../database/prisma.service";
import { FactsService } from "../facts/facts.service";
import { ProposalsService } from "../proposals/proposals.service";
import { RunsService } from "../runs/runs.service";
import { parseBuilderCallback, TelegramBuilder } from "./telegram-builder";
import { forTelegram, TELEGRAM_PROPOSAL_INCLUDE, TelegramNotices } from "./telegram-notices";

/** A command sent while the bot couldn't be reached arrives late; older than this, it's dropped. */
const MAX_COMMAND_AGE_SECONDS = 300;
/** /inbox sends this many proposals with their buttons; more get a list. */
const ONE_BY_ONE = 5;
/** Telegram shows "typing…" for about five seconds: renewed while the builder works. */
const TYPING_EVERY_MS = 4_000;

const Chat = z.object({ id: z.number(), type: z.string() });
const UpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      from: z.object({ id: z.number() }).optional(),
      chat: Chat,
      date: z.number(),
      text: z.string().optional(),
      /** A reply: to a question AI ME asked (M15-T3), it is the answer. */
      reply_to_message: z.object({ message_id: z.number() }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number() }),
      message: z.object({ message_id: z.number(), chat: Chat }).optional(),
      data: z.string().optional(),
    })
    .optional(),
});
type Update = z.infer<typeof UpdateSchema>;

const HELP = [
  "AI ME bot:",
  "/run <pipeline>: start a pipeline",
  "/status: what runs, what waits",
  "/inbox: the proposals waiting for me",
  "/pause: kill switch on (nothing runs or acts)",
  "/resume: kill switch off",
  "/new: a new chat with the pipeline builder",
  "/edit <pipeline>: change a pipeline with the builder",
  "Anything else goes to the pipeline builder: say what a pipeline should do.",
].join("\n");

/**
 * The AI ME bot, inbound (M12-T3/T4): commands and buttons from my private chat only (TELEGRAM_CHAT_ID is my user
 * id); anything else is ignored without an answer. The single user of this instance is APP_ADMIN_EMAIL.
 */
@Injectable()
export class TelegramBot {
  private readonly logger = new Logger(TelegramBot.name);
  private readonly ownerId: number | null;
  /** Builder turns answering in the background. */
  private readonly working = new Set<Promise<void>>();

  constructor(
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    private readonly prisma: PrismaService,
    private readonly proposals: ProposalsService,
    private readonly runs: RunsService,
    private readonly controls: ControlsService,
    private readonly notices: TelegramNotices,
    private readonly facts: FactsService,
    private readonly builder: TelegramBuilder,
  ) {
    this.ownerId = env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null;
  }

  /** Whatever Telegram sent. Never throws: Telegram would send it again. */
  async handle(raw: unknown, now = new Date()): Promise<void> {
    const parsed = UpdateSchema.safeParse(raw);
    if (!parsed.success || this.ownerId === null || !this.notices.configured) return;
    const update = parsed.data;
    try {
      if (update.callback_query) await this.button(update.callback_query);
      else if (update.message) await this.command(update.message, now);
    } catch (error) {
      this.logger.warn(`Telegram update ${update.update_id} not handled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Until every builder turn started so far has answered (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.working.size > 0) await Promise.all([...this.working]);
  }

  private mine(from: { id: number } | undefined, chat: { id: number; type: string } | undefined): boolean {
    return from?.id === this.ownerId && chat?.type === "private" && chat.id === this.ownerId;
  }

  private async command(message: NonNullable<Update["message"]>, now: Date): Promise<void> {
    if (!this.mine(message.from, message.chat)) return;
    if (message.reply_to_message && message.text && !message.text.startsWith("/")) {
      if (await this.answer(message.reply_to_message.message_id, message.text)) return;
    }
    if (now.getTime() / 1000 - message.date > MAX_COMMAND_AGE_SECONDS) return;
    const text = (message.text ?? "").trim();
    const [word = "", ...rest] = text.split(/\s+/);
    const command = word.toLowerCase().replace(/@\w+$/, "");
    const userId = await this.userId();
    if (text && !text.startsWith("/")) return this.talk(userId, text);
    switch (command) {
      case "/new":
        await this.builder.forget(userId);
        return this.tell("New chat with the pipeline builder: say what the pipeline should do.");
      case "/edit":
        return this.editPipeline(userId, rest.join(" "));
      case "/run":
        return this.run(userId, rest.join(" "));
      case "/status":
        return this.status(userId);
      case "/inbox":
        return this.inbox(userId);
      case "/pause": {
        const result = await this.controls.setKillSwitch(userId, true);
        return this.tell(`Kill switch on: nothing runs or acts.${result.stoppedRuns ? ` ${result.stoppedRuns} run(s) stopped.` : ""}`);
      }
      case "/resume":
        await this.controls.setKillSwitch(userId, false);
        return this.tell("Kill switch off: pipelines run again (stopped runs stay stopped).");
      default:
        return this.tell(HELP);
    }
  }

  /** A reply to a question's message: my answer (kept as a fact, the run goes on). False: it replies to something else. */
  private async answer(messageId: number, text: string): Promise<boolean> {
    const userId = await this.userId();
    const question = await this.facts.questionForTelegram(userId, messageId);
    if (!question) return false;
    try {
      const answered = await this.facts.answer(userId, question.questionId, text);
      await this.tell(`Thanks: "${answered.question}" is ${answered.answer}. Kept for the next forms; the run goes on.`);
    } catch (error) {
      await this.tell(`Not taken: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  /**
   * A message for the builder (M21): answered in the background, since a turn can take longer than Telegram waits
   * for this webhook (it would send the update again). "typing…" until then.
   */
  private talk(userId: string, text: string): void {
    const typing = () => void sendTelegramTyping(this.notices.config, this.notices.send).catch(() => undefined);
    typing();
    const timer = setInterval(typing, TYPING_EVERY_MS);
    const turn = this.builder
      .talk(userId, text)
      .then((answer) => this.tell(answer))
      .catch((error: unknown) => this.tell(`The builder didn't answer: ${reasonOf(error)}`))
      .catch((error: unknown) => this.logger.warn(`Builder answer not sent: ${reasonOf(error)}`))
      .finally(() => {
        clearInterval(timer);
        this.working.delete(turn);
      });
    this.working.add(turn);
  }

  private async editPipeline(userId: string, name: string): Promise<void> {
    const pipeline = await this.pipelineNamed(userId, name, "/edit");
    if (!pipeline) return;
    const chat = await this.builder.edit(userId, pipeline.pipelineId);
    await this.tell(`Talking about ${pipeline.name}${chat.currentVersion ? ` v${chat.currentVersion}` : ""}: what should change?`);
  }

  /** One of my saved pipelines by its name or the start of it; otherwise says which there are, and null. */
  private async pipelineNamed(userId: string, name: string, command: string): Promise<{ pipelineId: string; name: string } | null> {
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null } }, orderBy: { name: "asc" } });
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
      await this.tell(`${command} <pipeline>. Pipelines: ${pipelines.map((p) => p.name).join(", ") || "none yet"}`);
      return null;
    }
    const exact = pipelines.filter((p) => p.name.toLowerCase() === wanted);
    const found = exact.length ? exact : pipelines.filter((p) => p.name.toLowerCase().startsWith(wanted));
    if (found.length !== 1) {
      const which = found.length ? `"${name}" could be: ${found.map((p) => p.name).join(", ")}` : `No pipeline "${name}"`;
      await this.tell(`${which}. Pipelines: ${pipelines.map((p) => p.name).join(", ") || "none yet"}`);
      return null;
    }
    return found[0];
  }

  private async run(userId: string, name: string): Promise<void> {
    const pipeline = await this.pipelineNamed(userId, name, "/run");
    if (!pipeline) return;
    try {
      const run = await this.runs.start(userId, pipeline.pipelineId, false, "telegram");
      await this.say({ text: `Started ${pipeline.name}.`, buttons: this.open(`/runs/${run.runId}`, "Open the run") });
    } catch (error) {
      await this.say(`${pipeline.name} didn't start: ${reasonOf(error)}`);
    }
  }

  private async status(userId: string): Promise<void> {
    const [paused, running, waiting, proposals, recent] = await Promise.all([
      this.controls.isPaused(userId),
      this.prisma.client.run.count({ where: { userId, status: { in: ["QUEUED", "RUNNING"] } } }),
      this.prisma.client.run.count({ where: { userId, status: "WAITING_FOR_USER" } }),
      this.prisma.client.proposal.count({ where: { userId, status: "PENDING_REVIEW", run: { dryRun: false } } }),
      this.prisma.client.run.findMany({
        where: { userId },
        orderBy: { startedAt: "desc" },
        take: 5,
        include: { pipelineVersion: { select: { pipeline: { select: { name: true } } } } },
      }),
    ]);
    const lines = [
      `Kill switch: ${paused ? "ON" : "off"}`,
      `Running or queued: ${running} · waiting for me: ${waiting} · proposals: ${proposals}`,
      ...(recent.length ? ["", "Last runs:"] : []),
      ...recent.map((r) => `• ${r.pipelineVersion.pipeline.name}: ${r.status} (${r.trigger}, ${r.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC)`),
    ];
    await this.say({ text: lines.join("\n"), buttons: this.open("/", "Open AI ME") });
  }

  private async inbox(userId: string): Promise<void> {
    const pending = await this.prisma.client.proposal.findMany({
      where: { userId, status: "PENDING_REVIEW", run: { dryRun: false } },
      include: TELEGRAM_PROPOSAL_INCLUDE,
      orderBy: [{ dateCreated: "asc" }, { itemIndex: "asc" }],
    });
    if (pending.length === 0) return this.tell("Nothing waits for you.");
    if (pending.length > ONE_BY_ONE) {
      const lines = pending.slice(0, 20).map((p) => {
        const shown = forTelegram(p);
        return `• ${shown.pipeline}: ${shown.gate === "gate.review" ? "pick items" : shown.stepType} → ${shown.target}`;
      });
      const more = pending.length > 20 ? `\n… and ${pending.length - 20} more` : "";
      return this.tell({ text: `${pending.length} proposals wait:\n${lines.join("\n")}${more}`, buttons: this.open("/inbox", "Open the inbox") });
    }
    const approvals = await this.approvalsOn(userId);
    for (const proposal of pending) {
      const messageId = await this.say(proposalMessage(forTelegram(proposal), { approvals, appOrigin: this.env.APP_ORIGIN }));
      // The newest message about it is the one kept in line with its decision.
      await this.prisma.client.proposal.update({ where: { proposalId: proposal.proposalId }, data: { telegramMessageId: messageId, notifiedAt: new Date() } });
    }
  }

  private async button(query: NonNullable<Update["callback_query"]>): Promise<void> {
    if (!this.mine(query.from, query.message?.chat)) return;
    const answer = (text: string) => answerTelegramCallback(this.notices.config, query.id, text, this.notices.send);
    const built = parseBuilderCallback(query.data ?? "");
    if (built) {
      try {
        const result = await this.builder.press(await this.userId(), built);
        if (result.message) await this.tell(result.message);
        return answer(result.answer);
      } catch (error) {
        return answer(reasonOf(error).slice(0, 190));
      }
    }
    const callback = parseProposalCallback(query.data ?? "");
    if (!callback) return answer("Unknown button");
    const userId = await this.userId();
    const proposal = await this.prisma.client.proposal.findFirst({ where: { proposalId: callback.proposalId, userId }, include: TELEGRAM_PROPOSAL_INCLUDE });
    if (!proposal) return answer("That proposal is gone");
    const shown = forTelegram(proposal);
    if (proposal.status !== "PENDING_REVIEW") {
      if (query.message) await this.edit(query.message.message_id, decidedMessage(shown, `Already ${proposal.status.toLowerCase().replace("_", " ")}`));
      return answer(`Already ${proposal.status.toLowerCase().replace("_", " ")}`);
    }
    if (!(await this.approvalsOn(userId))) return answer("Approvals on Telegram are off (Settings): open it in AI ME");
    if (shown.gate !== "gate.act") return answer("Pick the items in AI ME");

    try {
      if (callback.action === "reject") {
        await this.proposals.reject(userId, proposal.proposalId, "Rejected on Telegram", "Telegram");
        return answer("Rejected");
      }
      const full = proposalMessage(shown, { approvals: true }).buttons?.flat().some((b) => b.text === "Approve") ?? false;
      if (!full) return answer("Too long to approve here: open it in AI ME");
      if (!hashMatches(shown.payloadHash, callback.hash)) return answer("It changed since this message: open it in AI ME");
      const fresh = ((proposal.targets as TargetView[] | null) ?? []).filter((t) => t.isNew);
      if (fresh.length) return answer(`New target ${fresh.map((t) => t.value).join(", ")}: approve it in AI ME`);
      await this.proposals.approve(userId, proposal.proposalId, { approveNewTargets: [] }, "Telegram");
      return answer("Approved: it acts now");
    } catch (error) {
      return answer(reasonOf(error).slice(0, 190));
    }
  }

  private async approvalsOn(userId: string): Promise<boolean> {
    return (await this.prisma.client.userSetting.findUnique({ where: { userId } }))?.telegramApprovals ?? true;
  }

  private async userId(): Promise<string> {
    return (await this.prisma.client.user.findUniqueOrThrow({ where: { email: this.env.APP_ADMIN_EMAIL } })).userId;
  }

  private open(path: string, text: string): TelegramMessage["buttons"] {
    return this.env.APP_ORIGIN ? [[{ text, url: `${this.env.APP_ORIGIN}${path}` }]] : [];
  }

  private async tell(message: string | TelegramMessage): Promise<void> {
    await this.say(message);
  }

  private say(message: string | TelegramMessage): Promise<number> {
    return sendTelegramMessage(this.notices.config, typeof message === "string" ? { text: message } : message, this.notices.send);
  }

  private async edit(messageId: number, message: TelegramMessage): Promise<void> {
    await editTelegramMessage(this.notices.config, messageId, message, this.notices.send).catch(() => undefined);
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === "string") return response;
    const text = (response as { message?: unknown }).message;
    return typeof text === "string" ? text : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
