import { sendTelegram, type TelegramSource } from "@realentity/storm-shared";
import { type StepContext, type StepExecutor } from "../runner/step-executor";

export type { TelegramSource };

/** notify.telegram: a message to the user (their chat only, Settings → Telegram), through the Bot API. */
export class TelegramStep implements StepExecutor {
  readonly type = "notify.telegram";

  constructor(
    private readonly config: TelegramSource,
    private readonly send: typeof fetch = fetch,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    await sendTelegram(this.config, `${context.dryRun ? "[Dry run] " : ""}${String(input.text)}`, this.send);
    return { sent: true };
  }
}
