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
import { type ModelChoice } from "./models";
import { isOpenAiModel, OpenAiApi, OpenAiChat, OpenAiClient, parseServerModel } from "./openai";
import { emptyUsage } from "./usage";

/** An OpenAI-compatible server's address and key. */
export interface ServerConfig {
  /** Up to and including `/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Tests: a fake server. */
  send?: typeof fetch;
}

/**
 * M62: where the models are, looked up at each call: the Claude key and the model servers of the user a model was
 * chosen for (`ModelChoice.owner`, Integration rows in Settings → AI), or a fixed setup (tests, evals, llm:check).
 * Null: not set up, or switched off.
 */
export interface ModelServers {
  claude(owner: string | undefined): Promise<string | null>;
  /** A server by its id in the model's id; null id: the one server of a fixed setup. */
  server(serverId: string | null, owner: string | undefined): Promise<ServerConfig | null>;
}

/** A fixed setup (M60's `--base-url`): the Claude key and one server, for every owner and server id. */
export function fixedServers(config: { anthropicApiKey?: string; openaiBaseUrl?: string; openaiApiKey?: string }): ModelServers {
  return {
    claude: () => Promise.resolve(config.anthropicApiKey ?? null),
    server: () => Promise.resolve(config.openaiBaseUrl ? { baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey } : null),
  };
}

const NOT_SET = {
  claude: "Claude isn't set up or is off (Settings → AI → Model servers)",
  server: "This model's server isn't set up or is off (Settings → AI → Model servers)",
};

/** One client per key or address, made when first used. */
class Clients {
  private readonly claude = new Map<string, { client: ClaudeClient; chat: ClaudeChat; batches: ClaudeBatches }>();
  private readonly servers = new Map<string, { client: OpenAiClient; chat: OpenAiChat; batches: SequentialBatches }>();

  constructor(private readonly where: ModelServers) {}

  async claudeOf(owner: string | undefined) {
    const key = await this.where.claude(owner);
    if (!key) return null;
    let clients = this.claude.get(key);
    if (!clients) {
      clients = { client: ClaudeClient.fromApiKey(key), chat: ClaudeChat.fromApiKey(key), batches: ClaudeBatches.fromApiKey(key) };
      this.claude.set(key, clients);
    }
    return clients;
  }

  async serverOf(model: string, owner: string | undefined) {
    const config = await this.where.server(parseServerModel(model).serverId, owner);
    if (!config) return null;
    const id = `${config.baseUrl}\n${config.apiKey ?? ""}`;
    let clients = this.servers.get(id);
    if (!clients) {
      const api = new OpenAiApi({ baseUrl: config.baseUrl, apiKey: config.apiKey, send: config.send });
      const client = new OpenAiClient(api);
      clients = { client, chat: new OpenAiChat(api), batches: new SequentialBatches(client) };
      this.servers.set(id, clients);
    }
    return clients;
  }

  /** The clients of a model's provider, or what to set up. */
  async of(choice: ModelChoice) {
    if (isOpenAiModel(choice.model)) return (await this.serverOf(choice.model, choice.owner)) ?? NOT_SET.server;
    return (await this.claudeOf(choice.owner)) ?? NOT_SET.claude;
  }
}

/** Structured calls, each to its model's provider. */
export class RoutedClient implements LlmClient {
  constructor(private readonly clients: Clients) {}

  async structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const provider = await this.clients.of(request.choice);
    if (typeof provider === "string") throw new LlmError(provider, emptyUsage());
    return provider.client.structured(request);
  }
}

/** Chats, each turn to its model's provider. */
export class RoutedChat implements LlmChat {
  constructor(private readonly clients: Clients) {}

  async send(request: ChatRequest): Promise<ChatResponse> {
    const provider = await this.clients.of(request.choice);
    if (typeof provider === "string") throw new Error(provider);
    return provider.chat.send(request);
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

/** Every SequentialBatches of the process, by batch id: a server's batches are found again without its config. */
const sequential = new Map<string, SequentialBatches>();

/**
 * Batches to the provider of their requests' model. The id says where it is: `seq_…` in this process, `claude:<owner>:…`
 * at Anthropic with that owner's key (M62: the key is looked up again when it is polled).
 */
export class RoutedBatches implements LlmBatches {
  constructor(private readonly clients: Clients) {}

  async submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string> {
    const choice = requests[0]?.request.choice ?? { model: "", effort: "low" };
    const provider = await this.clients.of(choice);
    if (typeof provider === "string") throw new Error(provider);
    const id = await provider.batches.submit(requests);
    if (provider.batches instanceof SequentialBatches) {
      sequential.set(id, provider.batches);
      return id;
    }
    return `claude:${choice.owner ?? ""}:${id}`;
  }

  private async byId(batchId: string): Promise<{ batches: LlmBatches; id: string }> {
    if (batchId.startsWith("seq_")) {
      const batches = sequential.get(batchId);
      if (!batches) throw new Error("The batch is gone: the worker restarted before it finished");
      return { batches, id: batchId };
    }
    const [, owner, id] = /^claude:([^:]*):(.+)$/.exec(batchId) ?? [null, "", batchId];
    const claude = await this.clients.claudeOf(owner || undefined);
    if (!claude) throw new Error(NOT_SET.claude);
    return { batches: claude.batches, id };
  }

  async ended(batchId: string): Promise<boolean> {
    const { batches, id } = await this.byId(batchId);
    return batches.ended(id);
  }

  async results<S extends z.ZodObject>(batchId: string, schema: S, model: string): Promise<BatchItemResult<z.infer<S>>[]> {
    const { batches, id } = await this.byId(batchId);
    const results = await batches.results(id, schema, model);
    if (batchId.startsWith("seq_")) sequential.delete(batchId);
    return results;
  }
}

/** The clients over a set of model servers; a call to a provider that isn't set up fails with where to set it up. */
export function llmOver(servers: ModelServers): { client: LlmClient; chat: LlmChat; batches: LlmBatches } {
  const clients = new Clients(servers);
  return { client: new RoutedClient(clients), chat: new RoutedChat(clients), batches: new RoutedBatches(clients) };
}

/** The clients of a fixed setup (tests, evals, `pnpm llm:check`). */
export function llmFromConfig(config: { anthropicApiKey?: string; openaiBaseUrl?: string; openaiApiKey?: string }) {
  return llmOver(fixedServers(config));
}
