import { EFFORTS, type EffortName } from "@realentity/storm-shared";
import { isOpenAiModel } from "./openai";

export type Effort = EffortName;

export interface ModelChoice {
  model: string;
  effort: Effort;
}

/** Task groups and their defaults (docs/design.md §5): cheap and fast for labelling, stronger for writing. */
const GROUPS: Record<string, { env: string; default: ModelChoice }> = {
  classify: { env: "LLM_MODEL_CLASSIFY", default: { model: "claude-haiku-5-5", effort: "low" } },
  writing: { env: "LLM_MODEL_WRITING", default: { model: "claude-sonnet-5-5", effort: "medium" } },
  reflection: { env: "LLM_MODEL_REFLECTION", default: { model: "claude-opus-5-5", effort: "high" } },
  builder: { env: "LLM_MODEL_BUILDER", default: { model: "claude-opus-5-5", effort: "high" } },
};

const GROUP_OF_TASK: Record<string, keyof typeof GROUPS> = {
  "llm.classify": "classify",
  "llm.score": "classify",
  "llm.generate": "writing",
  "llm.summarize": "writing",
  // A time and its zone out of an email: worth the writing model (M14-T2).
  "llm.extract": "writing",
  // Which application an email is about, and whether it is an answer: a classification (M16-T3).
  "application.outcome": "classify",
  "email.classify": "classify",
  // Which topics an email belongs to, when no direction says (M41-T3).
  "topic.match": "classify",
  // Whether an email states anything worth remembering about its topics: most don't (M42-T2).
  "topic.extract.screen": "classify",
  // What it states: new facts, changes and conflicts with what the topic knows.
  "topic.extract": "writing",
  // Which of a topic's facts say one thing together, and which no longer hold (M44-T8).
  "topic.tidy": "writing",
  "email.draftReply": "writing",
  "email.draftFollowUp": "writing",
  // Amounts and dates out of a bill's text: worth the writing model.
  "bill.read": "writing",
  reflection: "reflection",
  builder: "builder",
  // Selectors from a page outline: Sonnet does it at half Opus's price (M13 follow-up; Settings can choose Opus).
  "browser.teach": "writing",
  // A price from a page's text, only when the page has no product data (M13 follow-up).
  "shop.product": "classify",
  "browser.mapForm": "writing",
  "browser.agent": "writing",
  // The agent's second try, when the first model keeps failing (docs/design.md §5).
  "browser.agent.escalation": "builder",
};

/** A per-user choice from Settings (ModelSetting), if any. */
export type ModelSettingLookup = (userId: string, taskKey: string) => Promise<{ model: string; effort: string | null } | null>;

/**
 * M60: whether the user's local models are on (Settings, and OPENAI_BASE_URL set), and their model for every task
 * without its own choice.
 */
export interface LocalModels {
  on: boolean;
  model: string | null;
}

export type LocalModelsLookup = (userId: string) => Promise<LocalModels>;

/** Where a task's model comes from: its own setting, the local model for all tasks, `.env`, or the defaults. */
export type ModelSource = "settings" | "local" | "env" | "default";

/**
 * Which model and effort a task uses: the user's setting for that task (ModelSetting), else (M60, local models on) the
 * local model for all tasks, else the group's model from the environment (LLM_MODEL_CLASSIFY, LLM_MODEL_WRITING,
 * LLM_MODEL_REFLECTION, LLM_MODEL_BUILDER, else LLM_MODEL), else the group default.
 *
 * With `local` given and the user's local models off, every `openai:` model on the way is passed over: the task uses
 * Claude, and its local choice is kept for when they are on again. Without `local` (tests, evals), nothing is passed
 * over.
 */
export class ModelRouter {
  constructor(
    private readonly lookup: ModelSettingLookup,
    private readonly env: Record<string, string | undefined> = {},
    private readonly local?: LocalModelsLookup,
  ) {}

  async choose(userId: string, taskKey: string): Promise<ModelChoice> {
    const [setting, local] = await Promise.all([this.lookup(userId, taskKey), this.local?.(userId)]);
    const fallback = this.fallback(taskKey, local);
    if (!setting || !usable(setting.model, local)) return { model: fallback.model, effort: fallback.effort };
    return {
      model: setting.model,
      effort: setting.effort && (EFFORTS as readonly string[]).includes(setting.effort) ? (setting.effort as Effort) : fallback.effort,
    };
  }

  /** What a task uses without a setting of its own, and where that comes from (Settings shows it). */
  fallback(taskKey: string, local?: LocalModels): ModelChoice & { source: Exclude<ModelSource, "settings"> } {
    const group = GROUPS[GROUP_OF_TASK[taskKey] ?? "writing"];
    if (local?.on && local.model) return { model: local.model, effort: group.default.effort, source: "local" };
    // LLM_MODEL (M60): one model for every group without its own, e.g. a local one.
    const fromEnv = [this.env[group.env], this.env.LLM_MODEL].find((model) => model && usable(model, local));
    return fromEnv
      ? { model: fromEnv, effort: group.default.effort, source: "env" }
      : { model: group.default.model, effort: group.default.effort, source: "default" };
  }
}

/** A local model only while local models are on; Claude's always. */
export function usable(model: string, local: LocalModels | undefined): boolean {
  return !local || local.on || !isOpenAiModel(model);
}
