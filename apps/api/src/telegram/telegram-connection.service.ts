import { KeyRing, sealIntegration } from "@realentity/storm-crypto";
import { Integrations } from "@realentity/storm-db";
import {
  sendTelegram,
  setTelegramWebhook,
  telegramBotName,
  type TelegramConnectionRequest,
  type TelegramConnectionSaved,
  type TelegramConnectionView,
  type TelegramTestView,
} from "@realentity/storm-shared";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { hintOf } from "../integrations/integrations.service";
import { TelegramCommands } from "./telegram-commands";
import { TELEGRAM_FETCH } from "./telegram-notices";

interface TelegramRowConfig {
  chatId?: string;
  webhookUrl?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * M63: the Storm bot, set up in Settings → Telegram instead of .env (docs/design.md §7, telegram.md): its token sealed
 * with the integration key and never returned, the chat id, and the webhook secret, kept as its hash only. Changing the
 * token, the chat or the secret asks for the authenticator code again: they decide where your messages go and whose
 * commands are taken.
 */
@Injectable()
export class TelegramConnection {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyRing,
    private readonly integrations: Integrations,
    private readonly auth: AuthService,
    private readonly commands: TelegramCommands,
    @Inject(TELEGRAM_FETCH) private readonly send: typeof fetch,
  ) {}

  async get(userId: string): Promise<TelegramConnectionView> {
    return view(await this.row(userId));
  }

  async save(userId: string, body: TelegramConnectionRequest): Promise<TelegramConnectionSaved> {
    const existing = await this.row(userId);
    if (body.botToken !== undefined || body.chatId !== undefined || body.webhook !== undefined) this.auth.checkCode(body.code);
    if (!existing && (!body.botToken || !body.chatId)) throw new BadRequestException("The bot's token and your chat id are needed to set it up");

    const integrationId = existing?.integrationId ?? randomUUID();
    const config: TelegramRowConfig = { ...((existing?.config ?? {}) as TelegramRowConfig), ...(body.chatId !== undefined ? { chatId: body.chatId } : {}) };
    const webhookSecret = body.webhook ? (body.webhook.secret === "generate" ? randomBytes(32).toString("hex") : body.webhook.value) : undefined;

    // Registered before saving, with the token being saved (or the one there): a failure is told, the rest still saved.
    let registered: TelegramConnectionSaved["registered"];
    if (body.register && webhookSecret) {
      const botToken = body.botToken ?? (await this.openToken(userId));
      try {
        if (!botToken) throw new Error("no bot token saved");
        await setTelegramWebhook(botToken, body.register, webhookSecret, this.send);
        config.webhookUrl = body.register;
        registered = { ok: true, error: null };
      } catch (error) {
        registered = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const data = {
      config: { ...config },
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.botToken ? { ...sealIntegration(this.keys, integrationId, body.botToken), secretHint: hintOf(body.botToken) } : {}),
      ...(webhookSecret ? { secretHash: sha256(webhookSecret) } : {}),
    };
    const row = existing
      ? await this.prisma.client.integration.update({ where: { integrationId }, data })
      : await this.prisma.client.integration.create({ data: { integrationId, userId, kind: "TELEGRAM", name: "Telegram", ...data } });
    this.integrations.forget(userId);
    // A new bot or chat gets the command menu (M49).
    if (body.botToken !== undefined || body.chatId !== undefined || body.enabled) {
      this.commands.forgetMenu();
      await this.commands.sync(userId);
    }
    return {
      ...view(row),
      ...(body.webhook?.secret === "generate" && webhookSecret ? { webhookSecret } : {}),
      ...(registered ? { registered } : {}),
    };
  }

  /** The token works (getMe), and a message reaches your chat. */
  async test(userId: string): Promise<TelegramTestView> {
    const bot = (await this.integrations.of(userId)).find((i) => i.kind === "TELEGRAM");
    const chatId = typeof bot?.config.chatId === "string" ? bot.config.chatId : undefined;
    if (!bot?.secret || !chatId) return { ok: false, bot: null, error: "The bot isn't set up: save its token and your chat id first" };
    let name: string | null = null;
    try {
      name = await telegramBotName(bot.secret, this.send);
      await sendTelegram({ botToken: bot.secret, chatId }, "✅ Storm is connected: this is the test from Settings → Telegram.", this.send);
      return { ok: true, bot: name, error: null };
    } catch (error) {
      return { ok: false, bot: name, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Removed with its token and secret: nothing is sent, /hooks/telegram answers nothing. */
  async remove(userId: string): Promise<void> {
    await this.prisma.client.integration.deleteMany({ where: { userId, kind: "TELEGRAM" } });
    this.integrations.forget(userId);
    this.commands.forgetMenu();
  }

  private row(userId: string) {
    return this.prisma.client.integration.findFirst({ where: { userId, kind: "TELEGRAM" } });
  }

  private async openToken(userId: string): Promise<string | null> {
    return (await this.integrations.of(userId)).find((i) => i.kind === "TELEGRAM")?.secret ?? null;
  }
}

function view(row: { enabled: boolean; config: unknown; secretHint: string | null; secretHash: string | null; ciphertext: unknown; dateUpdated: Date } | null): TelegramConnectionView {
  const config = (row?.config ?? {}) as TelegramRowConfig;
  return {
    configured: Boolean(row?.ciphertext && config.chatId),
    enabled: row?.enabled ?? false,
    chatId: config.chatId ?? null,
    tokenHint: row?.secretHint ?? null,
    webhookSecretSet: Boolean(row?.secretHash),
    webhookUrl: config.webhookUrl ?? null,
    dateUpdated: row?.dateUpdated.toISOString() ?? null,
  };
}
