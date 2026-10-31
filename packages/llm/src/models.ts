export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  model: string;
  effort: Effort;
}

/** Task groups and their defaults (README §5): cheap and fast for labelling, stronger for writing. */
const GROUPS: Record<string, { env: string; default: ModelChoice }> = {
  classify: { env: "LLM_MODEL_CLASSIFY", default: { model: "claude-haiku-5-5", effort: "low" } },
  writing: { env: "LLM_MODEL_WRITING", default: { model: "claude-sonnet-5-5", effort: "medium" } },
};

const GROUP_OF_TASK: Record<string, keyof typeof GROUPS> = {
  "llm.classify": "classify",
  "llm.score": "classify",
  "llm.generate": "writing",
  "llm.summarize": "writing",
};

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** A per-user choice from Settings (ModelSetting), if any. */
export type ModelSettingLookup = (userId: string, taskKey: string) => Promise<{ model: string; effort: string | null } | null>;

/**
 * Which model and effort a task uses: my setting for that task (ModelSetting), else the group's model from the
 * environment (LLM_MODEL_CLASSIFY, LLM_MODEL_WRITING), else the group default.
 */
export class ModelRouter {
  constructor(
    private readonly lookup: ModelSettingLookup,
    private readonly env: Record<string, string | undefined> = {},
  ) {}

  async choose(userId: string, taskKey: string): Promise<ModelChoice> {
    const group = GROUPS[GROUP_OF_TASK[taskKey] ?? "writing"];
    const fallback = { model: this.env[group.env] || group.default.model, effort: group.default.effort };
    const setting = await this.lookup(userId, taskKey);
    if (!setting) return fallback;
    return {
      model: setting.model,
      effort: setting.effort && EFFORTS.includes(setting.effort) ? (setting.effort as Effort) : fallback.effort,
    };
  }
}
