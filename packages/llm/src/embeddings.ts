import { costUsd, emptyUsage, type LlmUsage } from "./usage";

/** The Examples.embedding column: vector(1024). Every provider returns vectors of this length. */
export const EMBEDDING_DIMENSIONS = 1024;

export interface Embeddings {
  /** Stored with each vector: only vectors of the same model are compared. */
  readonly model: string;
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: LlmUsage }>;
}

/** Long emails are cut: the start says what they are about, and the model's input limit is 8192 tokens. */
const MAX_CHARS = 12_000;

/**
 * OpenAI embeddings (docs/design.md §8: one interface; OpenAI, multilingual, 1024 dimensions via `dimensions`).
 * Errors never include the API key.
 */
export class OpenAiEmbeddings implements Embeddings {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<{ vectors: number[][]; usage: LlmUsage }> {
    if (texts.length === 0) return { vectors: [], usage: emptyUsage() };
    let response: Response;
    try {
      response = await this.send("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts.map((t) => t.slice(0, MAX_CHARS)), dimensions: EMBEDDING_DIMENSIONS }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("OpenAI could not be reached");
    }
    const body = (await response.json().catch(() => ({}))) as {
      data?: { index: number; embedding: number[] }[];
      usage?: { prompt_tokens?: number };
      error?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new Error(`OpenAI refused the embeddings request (${response.status}${body.error?.message ? `: ${body.error.message}` : ""})`);
    }
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`OpenAI returned ${vectors.length} embedding(s) of the wrong shape`);
    }
    const tokens = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return { vectors, usage: { models: [this.model], calls: 1, ...tokens, costUsd: costUsd(this.model, tokens) } };
  }
}
