import { randomUUID } from "node:crypto";
import { type z } from "zod";
import { type ChatRequest, type ChatResponse, type LlmChat, ClaudeChat } from "./chat";
import {
  type BatchItemResult,
  type BatchRequest,
  ClaudeBatches,
  ClaudeClient,
  type LlmBatches,
  type LlmClient,
  LlmError,
  type StructuredRequest,
  type StructuredResult,
} from "./claude-client";
import { isOpenAiModel, OpenAiApi, OpenAiChat, OpenAiClient } from "./openai";
import { emptyUsage } from "./usage";

/** Where the models are (M60): Claude with its key, and/or an OpenAI-compatible server. */
export interface LlmProviderConfig {
  anthropicApiKey?: string;
  /**
   * The OpenAI-compatible server (Ollama: http://localhost:11434/v1). Only it makes `openai:` models reachable: a key
   * alone (for embeddings) never sends a model's calls to OpenAI.
   */
  openaiBaseUrl?: string;
  /** Sent to the server as its key. */
  openaiApiKey?: string;
}

/** The OpenAI-compatible server, if one is set up. */
export function openAiApi(config: LlmProviderConfig): OpenAiApi | null {
  if (!config.openaiBaseUrl) return null;
  return new OpenAiApi({ baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey });
}

/** True when some model can answer: the LLM steps, the builder and reflection are on. */
export function llmConfigured(config: LlmProviderConfig): boolean {
  return Boolean(config.anthropicApiKey || config.openaiBaseUrl);
}

const NOT_SET = {
  claude: "ANTHROPIC_API_KEY is not set",
  openai: "No OpenAI-compatible server is set up (OPENAI_BASE_URL)",
};

/** The provider a model id belongs to: `openai:…` to the OpenAI-compatible server, anything else to Claude. */
function route<T>(model: string, claude: T | null, openai: T | null): T | string {
  if (isOpenAiModel(model)) return openai ?? NOT_SET.openai;
  return claude ?? NOT_SET.claude;
}

/** Structured calls, each to its model's provider. */
export class RoutedClient implements LlmClient {
  constructor(
    private readonly claude: LlmClient | null,
    private readonly openai: LlmClient | null,
  ) {}

  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const client = route(request.choice.model, this.claude, this.openai);
    if (typeof client === "string") return Promise.reject(new LlmError(client, emptyUsage()));
    return client.structured(request);
  }
}

/** Chats, each turn to its model's provider. */
export class RoutedChat implements LlmChat {
  constructor(
    private readonly claude: LlmChat | null,
    private readonly openai: LlmChat | null,
  ) {}

  send(request: ChatRequest): Promise<ChatResponse> {
    const chat = route(request.choice.model, this.claude, this.openai);
    if (typeof chat === "string") return Promise.reject(new Error(chat));
    return chat.send(request);
  }
}

/**
 * A batch without a batch API (M60-T4): the requests are called one after another, a few at a time, as soon as it is
 * submitted; `ended` is true once all are answered. Kept in memory: after a restart the batch is gone, and its results
 * say so (the caller fails it, as an expired batch).
 */
export class SequentialBatches implements LlmBatches {
  private readonly batches = new Map<string, { done: boolean; results: BatchItemResult<unknown>[] }>();

  constructor(
    private readonly client: LlmClient,
    private readonly concurrency = 2,
  ) {}

  submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string> {
    const id = `seq_${randomUUID()}`;
    const batch = { done: false, results: [] as BatchItemResult<unknown>[] };
    this.batches.set(id, batch);
    void this.run(requests, batch);
    return Promise.resolve(id);
  }

  private async run<S extends z.ZodObject>(requests: BatchRequest<S>[], batch: { done: boolean; results: BatchItemResult<unknown>[] }) {
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const { customId, request } = requests[next++];
        try {
          const { output, usage } = await this.client.structured(request);
          batch.results.push({ customId, ok: true, output, usage });
        } catch (error) {
          const usage = error instanceof LlmError ? error.usage : emptyUsage();
          batch.results.push({ customId, ok: false, error: error instanceof Error ? error.message : String(error), usage });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, requests.length) }, worker));
    batch.done = true;
  }

  ended(batchId: string): Promise<boolean> {
    return Promise.resolve(this.batches.get(batchId)?.done ?? true);
  }

  results<S extends z.ZodObject>(batchId: string): Promise<BatchItemResult<z.infer<S>>[]> {
    const batch = this.batches.get(batchId);
    if (!batch) return Promise.reject(new Error("The batch is gone: the worker restarted before it finished"));
    this.batches.delete(batchId);
    // Already checked against the schema by the client.
    return Promise.resolve(batch.results as BatchItemResult<z.infer<S>>[]);
  }
}

/** Batches to the provider of their requests' model; a batch's id says which provider holds it. */
export class RoutedBatches implements LlmBatches {
  constructor(
    private readonly claude: LlmBatches | null,
    private readonly openai: LlmBatches | null,
  ) {}

  private byId(batchId: string): LlmBatches {
    const batches = batchId.startsWith("seq_") ? this.openai : this.claude;
    if (!batches) throw new Error(batchId.startsWith("seq_") ? NOT_SET.openai : NOT_SET.claude);
    return batches;
  }

  submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string> {
    const batches = route(requests[0]?.request.choice.model ?? "", this.claude, this.openai);
    if (typeof batches === "string") return Promise.reject(new Error(batches));
    return batches.submit(requests);
  }

  ended(batchId: string): Promise<boolean> {
    return this.byId(batchId).ended(batchId);
  }

  results<S extends z.ZodObject>(batchId: string, schema: S, model: string): Promise<BatchItemResult<z.infer<S>>[]> {
    return this.byId(batchId).results(batchId, schema, model);
  }
}

/** The clients for the configured providers; a call to a provider that isn't set up fails with what to set. */
export function llmFromConfig(config: LlmProviderConfig): { client: LlmClient; chat: LlmChat; batches: LlmBatches | null; configured: boolean } {
  const api = openAiApi(config);
  const key = config.anthropicApiKey;
  const openaiClient = api ? new OpenAiClient(api) : null;
  return {
    client: new RoutedClient(key ? ClaudeClient.fromApiKey(key) : null, openaiClient),
    chat: new RoutedChat(key ? ClaudeChat.fromApiKey(key) : null, api ? new OpenAiChat(api) : null),
    batches: key || openaiClient ? new RoutedBatches(key ? ClaudeBatches.fromApiKey(key) : null, openaiClient ? new SequentialBatches(openaiClient) : null) : null,
    configured: llmConfigured(config),
  };
}
