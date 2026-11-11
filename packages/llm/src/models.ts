import { EFFORTS, type EffortName } from "@realentity/storm-shared";

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
 * Which model and effort a task uses: the user's setting for that task (ModelSetting), else the group's model from the
 * environment (LLM_MODEL_CLASSIFY, LLM_MODEL_WRITING, LLM_MODEL_REFLECTION, LLM_MODEL_BUILDER), else the group default.
 */
export class ModelRouter {
  constructor(
    private readonly lookup: ModelSettingLookup,
    private readonly env: Record<string, string | undefined> = {},
  ) {}

  async choose(userId: string, taskKey: string): Promise<ModelChoice> {
    const fallback = this.fallback(taskKey);
    const setting = await this.lookup(userId, taskKey);
    if (!setting) return { model: fallback.model, effort: fallback.effort };
    return {
      model: setting.model,
      effort: setting.effort && (EFFORTS as readonly string[]).includes(setting.effort) ? (setting.effort as Effort) : fallback.effort,
    };
  }

  /** What a task uses without a setting, and where that comes from (Settings shows it). */
  fallback(taskKey: string): ModelChoice & { source: "env" | "default" } {
    const group = GROUPS[GROUP_OF_TASK[taskKey] ?? "writing"];
    const fromEnv = this.env[group.env];
    return fromEnv
      ? { model: fromEnv, effort: group.default.effort, source: "env" }
      : { model: group.default.model, effort: group.default.effort, source: "default" };
  }
}
