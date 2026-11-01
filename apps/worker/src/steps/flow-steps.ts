import { type CancelOn, type LaterStarts } from "../runner/later";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { durationMs, toInstant } from "./time";

interface LaterInput {
  pipeline: string;
  after?: string;
  at?: string;
  timeZone: string;
  data: Record<string, unknown>;
  key?: string;
  cancelOn?: CancelOn;
}

/** flow.later (M14-T3): another pipeline started later with data, unless cancelled first. A dry run schedules nothing. */
export class FlowLaterStep implements StepExecutor {
  readonly type = "flow.later";

  constructor(private readonly later: LaterStarts) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { pipeline, after, at, timeZone, data, key, cancelOn } = input as unknown as LaterInput;
    if (!after === !at) throw new Error("flow.later needs `after` (e.g. 7d) or `at` (a time): one of them");
    const fireAt = at ? toInstant(at, timeZone) : new Date(Date.now() + durationMs(after!));
    if (fireAt.getTime() <= Date.now()) throw new Error(`flow.later's time ${fireAt.toISOString()} has passed`);
    if (context.dryRun) return { scheduledStartId: null, fireAt: fireAt.toISOString(), replaced: 0 };
    const { scheduledStartId, replaced } = await this.later.schedule({
      userId: context.userId,
      pipeline,
      fireAt,
      data,
      ...(key ? { key } : {}),
      ...(cancelOn ? { cancelOn } : {}),
      scheduledByRunId: context.runId,
    });
    return { scheduledStartId, fireAt: fireAt.toISOString(), replaced };
  }
}

/** flow.cancel (M14-T3): the pending flow.later starts with a key, cancelled. A dry run cancels nothing. */
export class FlowCancelStep implements StepExecutor {
  readonly type = "flow.cancel";

  constructor(private readonly later: LaterStarts) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { key } = input as { key: string };
    return { cancelled: context.dryRun ? 0 : await this.later.cancel(context.userId, key) };
  }
}
