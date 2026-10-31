import { type StepContext, type StepExecutor } from "../runner/step-executor";

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

/**
 * notify.telegram: a message to me (my chat only, from .env), through the Bot API. Errors never include the
 * request URL: it contains the bot token.
 */
export class TelegramStep implements StepExecutor {
  readonly type = "notify.telegram";

  constructor(
    private readonly config: TelegramConfig,
    private readonly send: typeof fetch = fetch,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { botToken, chatId } = this.config;
    if (!botToken || !chatId) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    const text = `${context.dryRun ? "[Dry run] " : ""}${String(input.text)}`;

    let response: Response;
    try {
      response = await this.send(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Telegram could not be reached");
    }
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!response.ok || !body.ok)
      throw new Error(`Telegram refused the message (${response.status}${body.description ? `: ${body.description}` : ""})`);
    return { sent: true };
  }
}
