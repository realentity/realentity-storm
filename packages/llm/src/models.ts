import { EFFORTS, type EffortName } from "@realentity/storm-shared";

export type Effort = EffortName;

export interface ModelChoice {
  model: string;
  effort: Effort;
  /**
   * M62: whose settings it was chosen from: the clients find the Claude key and the model servers there (Integration).
   * Absent in tests and evals, whose clients have a fixed setup.
   */
  owner?: string;
}

/** Task groups and their defaults (docs/design.md §5): cheap and fast for labelling, stronger for writing. */
const GROUPS: Record<string, ModelChoice> = {
  classify: { model: "claude-haiku-5-5", effort: "low" },
  writing: { model: "claude-sonnet-5-5", effort: "medium" },
  reflection: { model: "claude-opus-5-5", effort: "high" },
  builder: { model: "claude-opus-5-5", effort: "high" },
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
 * M62: the user's model settings beyond a task's own: the default model (Settings → AI), and which models can be used
 * now (Claude set up and on; a model's server there and on).
 */
export interface ModelPrefs {
  defaultModel: string | null;
  usable(model: string): boolean;
}

export type ModelPrefsLookup = (userId: string) => Promise<ModelPrefs>;

/** Where a task's model comes from: its own setting, the default model in Settings, or the built-in default. */
export type ModelSource = "settings" | "default" | "built-in";

/**
 * Which model and effort a task uses (docs/design.md §5): the user's setting for that task (ModelSetting), else the
 * default model (Settings → AI), else the task group's built-in default. A choice whose model can't be used now (its
 * server is off or gone) is passed over, and kept for when it can again. Without `prefs` (tests, evals): a task's
 * setting, else the built-in default.
 */
export class ModelRouter {
  constructor(
    private readonly lookup: ModelSettingLookup,
    private readonly prefs?: ModelPrefsLookup,
  ) {}

  async choose(userId: string, taskKey: string): Promise<ModelChoice> {
    const [setting, prefs] = await Promise.all([this.lookup(userId, taskKey), this.prefs?.(userId)]);
    const fallback = this.fallback(taskKey, prefs);
    if (!setting || (prefs && !prefs.usable(setting.model))) return { model: fallback.model, effort: fallback.effort, owner: userId };
    return {
      model: setting.model,
      effort: setting.effort && (EFFORTS as readonly string[]).includes(setting.effort) ? (setting.effort as Effort) : fallback.effort,
      owner: userId,
    };
  }

  /** Whether a model can be used now for the user (its server set up and on); always without `prefs`. */
  async usable(userId: string, model: string): Promise<boolean> {
    return !this.prefs || (await this.prefs(userId)).usable(model);
  }

  /** What a task uses without a setting of its own, and where that comes from (Settings shows it). */
  fallback(taskKey: string, prefs?: ModelPrefs): ModelChoice & { source: Exclude<ModelSource, "settings"> } {
    const group = GROUPS[GROUP_OF_TASK[taskKey] ?? "writing"];
    if (prefs?.defaultModel && prefs.usable(prefs.defaultModel)) return { model: prefs.defaultModel, effort: group.effort, source: "default" };
    return { model: group.model, effort: group.effort, source: "built-in" };
  }
}
