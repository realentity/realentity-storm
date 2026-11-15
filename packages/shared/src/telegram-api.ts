/** One of the Storm bot's commands, as Settings lists them (M49). */
export interface TelegramCommandView {
  /** Without the slash. */
  command: string;
  description: string;
  /** null: Storm's own (/run, /inbox, …); else the pipeline it starts. */
  pipeline: { pipelineId: string; name: string; enabled: boolean } | null;
  /** It answers now: Storm's own always; a pipeline's only while that pipeline is on. */
  answers: boolean;
  /** An off pipeline's command that another pipeline, on, has: that one's name; switching this on is refused. */
  takenBy: string | null;
}

export interface TelegramCommandsView {
  /** The bot is set up (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID): without it no command answers. */
  configured: boolean;
  commands: TelegramCommandView[];
}
