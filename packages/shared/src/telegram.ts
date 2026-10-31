export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

/**
 * Sends a message to my chat through the Bot API (notify.telegram, the worker-down alert). Errors never include
 * the request URL: it contains the bot token.
 */
export async function sendTelegram(config: TelegramConfig, text: string, send: typeof fetch = fetch): Promise<void> {
  const { botToken, chatId } = config;
  if (!botToken || !chatId) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
  let response: Response;
  try {
    response = await send(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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
}
