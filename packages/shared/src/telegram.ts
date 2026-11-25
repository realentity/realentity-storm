export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

/** M63: the bot as saved in Settings → Telegram, looked up at each call (a change needs no restart). */
export type TelegramLookup = () => Promise<TelegramConfig>;
/** A fixed config (tests, a one-off call) or the lookup. */
export type TelegramSource = TelegramConfig | TelegramLookup;

export async function telegramConfig(source: TelegramSource): Promise<TelegramConfig> {
  return typeof source === "function" ? source() : source;
}

/** The bot can send: a token and a chat id. */
export async function telegramReady(source: TelegramSource): Promise<boolean> {
  const { botToken, chatId } = await telegramConfig(source);
  return Boolean(botToken && chatId);
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
export async function sendTelegram(source: TelegramSource, text: string, send: typeof fetch = fetch): Promise<void> {
  const config = await telegramConfig(source);
  await callTelegram(config, "sendMessage", { chat_id: config.chatId, text, link_preview_options: { is_disabled: true } }, send);
}

/** A message, with buttons, to the user's chat; its message id, to edit it later. */
export async function sendTelegramMessage(source: TelegramSource, message: TelegramMessage, send: typeof fetch = fetch): Promise<number> {
  const config = await telegramConfig(source);
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
  source: TelegramSource,
  messageId: number,
  message: TelegramMessage,
  send: typeof fetch = fetch,
): Promise<void> {
  const config = await telegramConfig(source);
  await callTelegram(
    config,
    "editMessageText",
    { chat_id: config.chatId, message_id: messageId, text: message.text, link_preview_options: { is_disabled: true }, ...markup(message.buttons ?? []) },
    send,
  );
}

/** Ends a button's spinner, with a short notice when given. */
export async function answerTelegramCallback(source: TelegramSource, callbackQueryId: string, text?: string, send: typeof fetch = fetch): Promise<void> {
  await callTelegram(await telegramConfig(source), "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }, send);
}

/** "typing…" in the chat for about five seconds, while a slow answer is on its way. */
export async function sendTelegramTyping(source: TelegramSource, send: typeof fetch = fetch): Promise<void> {
  const config = await telegramConfig(source);
  await callTelegram(config, "sendChatAction", { chat_id: config.chatId, action: "typing" }, send);
}

/** M49: the bot's command menu (setMyCommands), for the user's chat; the whole list each time. */
export async function setTelegramCommands(
  source: TelegramSource,
  commands: readonly { command: string; description: string }[],
  send: typeof fetch = fetch,
): Promise<void> {
  const config = await telegramConfig(source);
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
export async function downloadTelegramFile(source: TelegramSource, fileId: string, maxBytes = TELEGRAM_FILE_MAX_BYTES, send: typeof fetch = fetch): Promise<Buffer> {
  const config = await telegramConfig(source);
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

/** M63: the bot's @username, which also proves the token works (getMe). */
export async function telegramBotName(botToken: string, send: typeof fetch = fetch): Promise<string> {
  const me = (await callBot(botToken, "getMe", {}, send)) as { username?: string };
  return me.username ? `@${me.username}` : "the bot";
}

/** M63: Telegram posts the bot's updates to `url`, with `secret` in X-Telegram-Bot-Api-Secret-Token (setWebhook). */
export async function setTelegramWebhook(botToken: string, url: string, secret: string, send: typeof fetch = fetch): Promise<void> {
  await callBot(
    botToken,
    "setWebhook",
    { url, secret_token: secret, allowed_updates: ["message", "callback_query"], max_connections: 2, drop_pending_updates: true },
    send,
  );
}

async function callTelegram(config: TelegramConfig, method: string, body: Record<string, unknown>, send: typeof fetch): Promise<unknown> {
  const { botToken, chatId } = config;
  if (!botToken || !chatId) throw new Error("The Storm bot isn't set up (Settings → Telegram)");
  return callBot(botToken, method, body, send);
}

async function callBot(botToken: string, method: string, body: Record<string, unknown>, send: typeof fetch): Promise<unknown> {
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
