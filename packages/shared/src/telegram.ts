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
 * Sends a message to the user's chat through the Bot API (notify.telegram, the worker-down alert). Errors never include
 * the request URL: it contains the bot token.
 */
export async function sendTelegram(config: TelegramConfig, text: string, send: typeof fetch = fetch): Promise<void> {
  await callTelegram(config, "sendMessage", { chat_id: config.chatId, text, link_preview_options: { is_disabled: true } }, send);
}

/** A message, with buttons, to the user's chat; its message id, to edit it later. */
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

/** M49: the bot's command menu (setMyCommands), for the user's chat; the whole list each time. */
export async function setTelegramCommands(
  config: TelegramConfig,
  commands: readonly { command: string; description: string }[],
  send: typeof fetch = fetch,
): Promise<void> {
  await callTelegram(
    config,
    "setMyCommands",
    { commands: commands.map((c) => ({ command: c.command, description: c.description.slice(0, 256) })), scope: { type: "chat", chat_id: Number(config.chatId) } },
    send,
  );
}

/** The Bot API lets a bot download files up to this size. */
export const TELEGRAM_FILE_MAX_BYTES = 20 * 1_048_576;

/** M49: a file sent to the bot (a photo, a document), by its file_id: its content, within `maxBytes`. */
export async function downloadTelegramFile(config: TelegramConfig, fileId: string, maxBytes = TELEGRAM_FILE_MAX_BYTES, send: typeof fetch = fetch): Promise<Buffer> {
  const file = (await callTelegram(config, "getFile", { file_id: fileId }, send)) as { file_path?: string; file_size?: number };
  if (!file.file_path) throw new Error("Telegram has no such file (or it is larger than 20 MB)");
  if ((file.file_size ?? 0) > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1_048_576)} MB`);
  let response: Response;
  try {
    response = await send(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("Telegram could not be reached");
  }
  if (!response.ok) throw new Error(`Telegram didn't give the file (${response.status})`);
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1_048_576)} MB`);
  return content;
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
