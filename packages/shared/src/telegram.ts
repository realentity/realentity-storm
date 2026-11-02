export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

/** An inline button under a message: it opens a link, or sends `data` back to the bot (a callback query). */
export type TelegramButton = { text: string; url: string } | { text: string; data: string };

export interface TelegramMessage {
  text: string;
  /** Rows of buttons. */
  buttons?: TelegramButton[][];
}

/** Telegram's limit for a message's text. */
export const TELEGRAM_MAX_TEXT = 4096;

/**
 * Sends a message to my chat through the Bot API (notify.telegram, the worker-down alert). Errors never include
 * the request URL: it contains the bot token.
 */
export async function sendTelegram(config: TelegramConfig, text: string, send: typeof fetch = fetch): Promise<void> {
  await callTelegram(config, "sendMessage", { chat_id: config.chatId, text, link_preview_options: { is_disabled: true } }, send);
}

/** A message, with buttons, to my chat; its message id, to edit it later. */
export async function sendTelegramMessage(config: TelegramConfig, message: TelegramMessage, send: typeof fetch = fetch): Promise<number> {
  const result = await callTelegram(
    config,
    "sendMessage",
    { chat_id: config.chatId, text: message.text, link_preview_options: { is_disabled: true }, ...markup(message.buttons) },
    send,
  );
  return (result as { message_id: number }).message_id;
}

/** Replaces a message's text and buttons (no buttons: removes them). */
export async function editTelegramMessage(
  config: TelegramConfig,
  messageId: number,
  message: TelegramMessage,
  send: typeof fetch = fetch,
): Promise<void> {
  await callTelegram(
    config,
    "editMessageText",
    { chat_id: config.chatId, message_id: messageId, text: message.text, link_preview_options: { is_disabled: true }, ...markup(message.buttons ?? []) },
    send,
  );
}

/** Ends a button's spinner, with a short notice when given. */
export async function answerTelegramCallback(config: TelegramConfig, callbackQueryId: string, text?: string, send: typeof fetch = fetch): Promise<void> {
  await callTelegram(config, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }, send);
}

/** "typing…" in the chat for about five seconds, while a slow answer is on its way. */
export async function sendTelegramTyping(config: TelegramConfig, send: typeof fetch = fetch): Promise<void> {
  await callTelegram(config, "sendChatAction", { chat_id: config.chatId, action: "typing" }, send);
}

async function callTelegram(config: TelegramConfig, method: string, body: Record<string, unknown>, send: typeof fetch): Promise<unknown> {
  const { botToken, chatId } = config;
  if (!botToken || !chatId) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
  let response: Response;
  try {
    response = await send(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Telegram could not be reached");
  }
  const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (!response.ok || !answer.ok)
    throw new Error(`Telegram refused the message (${response.status}${answer.description ? `: ${answer.description}` : ""})`);
  return answer.result;
}

function markup(buttons: TelegramButton[][] | undefined): Record<string, unknown> {
  if (!buttons) return {};
  return {
    reply_markup: {
      inline_keyboard: buttons.map((row) => row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
    },
  };
}
