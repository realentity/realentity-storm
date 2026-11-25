import { costUsd, emptyUsage, type LlmUsage } from "./usage";

/** The Examples.embedding column: vector(1024). Every provider returns vectors of this length. */
export const EMBEDDING_DIMENSIONS = 1024;

export interface Embeddings {
  /** Stored with each vector: only vectors of the same model are compared. */
  readonly model: string;
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: LlmUsage }>;
}

/**
 * M62: the embeddings of the moment, from Settings → AI (a model server and its model): looked up where the work
 * starts (a step, a learning job), for whom it is done. Null: none chosen, or its server is off.
 */
export interface EmbeddingsSource {
  current(owner?: string): Promise<Embeddings | null>;
}

/** Long emails are cut: the start says what they are about, and the model's input limit is 8192 tokens. */
const MAX_CHARS = 12_000;

/**
 * Embeddings from an OpenAI-compatible server (docs/design.md §8: one interface): OpenAI's text-embedding-3-large
 * with `dimensions: 1024`, or a local model of 1024 dimensions (bge-m3 on Ollama, M62). Errors never include the key.
 */
export class OpenAiEmbeddings implements Embeddings {
  constructor(
    private readonly apiKey: string | undefined,
    readonly model: string,
    private readonly send: typeof fetch = fetch,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async embed(texts: string[]): Promise<{ vectors: number[][]; usage: LlmUsage }> {
    if (texts.length === 0) return { vectors: [], usage: emptyUsage() };
    let response: Response;
    try {
      response = await this.send(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts.map((t) => t.slice(0, MAX_CHARS)), dimensions: EMBEDDING_DIMENSIONS }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("The embeddings server could not be reached");
    }
    const body = (await response.json().catch(() => ({}))) as {
      data?: { index: number; embedding: number[] }[];
      usage?: { prompt_tokens?: number };
      error?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new Error(`The embeddings server refused the request (${response.status}${body.error?.message ? `: ${body.error.message}` : ""})`);
    }
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`The embeddings server returned ${vectors.length} embedding(s) of the wrong shape (${EMBEDDING_DIMENSIONS} dimensions needed)`);
    }
    const tokens = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return { vectors, usage: { models: [this.model], calls: 1, ...tokens, costUsd: costUsd(this.model, tokens) } };
  }
}

/** A source over a lookup of the embeddings server and model (Integrations.embeddings in the api and the worker). */
export function embeddingsFrom(lookup: (owner?: string) => Promise<{ baseUrl: string; apiKey?: string; model: string } | null>): EmbeddingsSource {
  return {
    current: async (owner) => {
      const server = await lookup(owner);
      if (!server) return null;
      let end = server.baseUrl.length;
      while (end > 0 && server.baseUrl[end - 1] === "/") end--;
      return new OpenAiEmbeddings(server.apiKey, server.model, fetch, server.baseUrl.slice(0, end));
    },
  };
}

/** A fixed Embeddings (tests, evals) or a source (the app), as a source; null: none. */
export function embeddingsSource(embeddings: Embeddings | EmbeddingsSource | null | undefined): EmbeddingsSource | null {
  if (!embeddings) return null;
  if ("current" in embeddings) return embeddings;
  return { current: () => Promise.resolve(embeddings) };
}
