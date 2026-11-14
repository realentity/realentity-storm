import { type LlmUsage } from "@realentity/storm-llm";
import { type TriggerEventName } from "@realentity/storm-shared";

/** What a step implementation knows about where it runs. */
export interface StepContext {
  runId: string;
  userId: string;
  pipelineId: string;
  stepId: string;
  stepKey: string;
  itemIndex: number | null;
  dryRun: boolean;
  /** The pipeline's App (M30), by name: data.save { type } and data.read work on its entities. */
  app?: string;
  /** M39-T3: its id, as resolved when the version was saved: what the App is found by (a rename breaks nothing). */
  appId?: string;
  /** M39-T3: the pipelines the version names (flow.later's), by name → id, as resolved when it was saved. */
  pipelineIds?: Readonly<Record<string, string>>;
  /** LLM steps report each call's usage; it is saved on the step (Step.llmUsage), also when the step fails. */
  recordUsage(usage: LlmUsage): void;
  /**
   * The monthly budget is reached and this pipeline isn't essential (M19-T1): for a step whose LLM calls are optional
   * (browser.extract's fallback). Steps flagged `llm` in the catalog never start then.
   */
  budgetStops?(): Promise<boolean>;
  /** Headed steps: pausing for the user in the live view (docs/design.md §6). */
  attention: Attention;
  /**
   * The pipeline's allowed domains (its policy), and on a side-effect step the new ones the user approved at its gate:
   * where browser.agent and browser.submit may go besides their start address's site.
   */
  allowedDomains?: readonly string[];
  /**
   * M50: the run's credential slots, slot → the credential bound to it (by id): {{cred:slot}} is opened through these,
   * never by a credential's name.
   */
  credentials?: Readonly<Record<string, string>>;
  /**
   * M47: this check's address is a field of mine (the compiler said so, policy.privateHosts): it may be a private, LAN
   * or Tailscale address. Never a link-local or cloud metadata one.
   */
  privateHosts?: boolean;
  /**
   * Something happened that may start other pipelines (M12-T1): a recipe broke, an application moved, an email was
   * labelled. Never throws; does nothing in a dry run.
   */
  emit?(event: TriggerEventName, data: Record<string, unknown>): Promise<void>;
}

/**
 * How a headed step hands the page to the user and gets it back. Both wait with the page kept open, and throw
 * RunStopped when the user aborts (or the kill switch is on).
 */
export interface Attention {
  /** At a safe point between actions: if the user pressed Take over, waits until they continue. */
  checkpoint(url?: string): Promise<void>;
  /** The page needs the user (CAPTCHA, 2FA, a page it doesn't recognize): waits until they continue. */
  needMe(reason: string, url?: string, options?: NeedMeOptions): Promise<void>;
}

/** A wait for something other than a page (M14: a Google reconnect): what continues it, and the message's button. */
export interface NeedMeOptions {
  /** "google": signing in with Google again continues it (the api does that). */
  waitsFor?: string;
  /** Instead of "Open the live view". */
  button?: { text: string; url: string };
  /** false: no "Storm needs you" message (the step sends its own, e.g. a question to reply to). */
  notify?: boolean;
}

/** The run is to stop (Abort in the live view, the kill switch): the runner aborts it instead of failing the step. */
export class RunStopped extends Error {}

/** Outside a run with a live view (headless, tests): nobody can take over, so needing the user fails the step. */
export const NO_ATTENTION: Attention = {
  checkpoint: () => Promise.resolve(),
  needMe: (reason, _url, options) =>
    Promise.reject(new Error(options?.waitsFor ? reason : `${reason}: needs you, and this step has no live view (set headed: true to take over)`)),
};

/**
 * The implementation of one catalog step type (docs/design.md §2.3). Inputs arrive resolved and validated against the
 * step's input schema; the returned value is validated against its output schema.
 */
export interface StepExecutor {
  readonly type: string;
  execute(input: Record<string, unknown>, context: StepContext): Promise<unknown>;
}

export class ExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>();

  constructor(executors: Iterable<StepExecutor> = []) {
    for (const executor of executors) {
      if (this.executors.has(executor.type)) throw new Error(`Executor for ${executor.type} is registered twice`);
      this.executors.set(executor.type, executor);
    }
  }

  get(type: string): StepExecutor | undefined {
    return this.executors.get(type);
  }
}
