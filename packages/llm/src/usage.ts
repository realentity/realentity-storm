/** USD per million tokens. Cache writes are 1.25× input (5-minute TTL). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * First-party API prices (cached 2026-10), and OpenAI's for the embedding models. Haiku 5.5 is priced for prompts up to 100K tokens. An unknown model is
 * charged at the most expensive known rate, so the budget errs on the safe side.
 */
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Embeddings (few-shot examples): input only.
  "text-embedding-3-large": { input: 0.13, output: 0, cacheRead: 0 },
  "text-embedding-3-small": { input: 0.02, output: 0, cacheRead: 0 },
};
const MOST_EXPENSIVE = PRICES["claude-fable-5-1"];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What LLM calls of one step cost; stored in Step.llmUsage (the budget sums `costUsd`). */
export interface LlmUsage extends TokenCounts {
  /** The model(s) that answered, in order of first use. */
  models: string[];
  calls: number;
  costUsd: number;
}

export function isPriced(model: string): boolean {
  return model in PRICES;
}

export function costUsd(model: string, tokens: TokenCounts): number {
  const price = PRICES[model] ?? MOST_EXPENSIVE;
  const usd =
    (tokens.inputTokens * price.input +
      tokens.cacheWriteTokens * price.input * 1.25 +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.outputTokens * price.output) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function emptyUsage(): LlmUsage {
  return { models: [], calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function addUsage(total: LlmUsage, more: LlmUsage): LlmUsage {
  return {
    models: [...new Set([...total.models, ...more.models])],
    calls: total.calls + more.calls,
    inputTokens: total.inputTokens + more.inputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    cacheReadTokens: total.cacheReadTokens + more.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + more.cacheWriteTokens,
    costUsd: Math.round((total.costUsd + more.costUsd) * 1_000_000) / 1_000_000,
  };
}
