import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { type z } from "zod";
import { type ModelChoice } from "./models";
import { addUsage, costUsd, emptyUsage, type LlmUsage } from "./usage";

export interface StructuredRequest<S extends z.ZodObject> {
  choice: ModelChoice;
  /** Stable instructions for the task. */
  system: string;
  /** The task's input; untrusted content goes inside tags the system prompt calls data. */
  prompt: string;
  /** What the answer must be: validated before it is returned. */
  schema: S;
  maxTokens?: number;
  /**
   * Caches the system prompt (docs/design.md §5): for calls that repeat it within minutes (per-item drafts, chunked
   * classification). Below the model's minimum prefix it simply isn't cached; a cache write costs 1.25× input.
   */
  cacheSystem?: boolean;
  /**
   * A long start of the prompt that repeats across calls (a page outline, asked again with what failed): cached with
   * the system prompt, `prompt` follows it. Retries then pay a tenth for it.
   */
  cachedPrompt?: string;
  /**
   * M46: images (JPEG, PNG, WebP, GIF) and PDFs the model sees before the prompt: an entity's scan, a receipt. They are
   * data like any content: the system prompt says so.
   */
  files?: LlmFile[];
}

/** A file sent with a request: an image, or a PDF (its pages as text and as images). */
export interface LlmFile {
  name: string;
  mime: string;
  data: Buffer;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/** The content blocks of the files, each followed by its name so the prompt can refer to it. */
function fileBlocks(files: LlmFile[]): Anthropic.Beta.BetaContentBlockParam[] {
  return files.flatMap((file, index): Anthropic.Beta.BetaContentBlockParam[] => {
    const data = file.data.toString("base64");
    const label = { type: "text" as const, text: `<file index="${index}" name="${file.name.replace(/[<>"]/g, "")}"/>` };
    if (file.mime === "application/pdf") return [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }, label];
    const media = IMAGE_TYPES.find((t) => t === file.mime);
    if (!media) throw new Error(`${file.name} is a ${file.mime} file: the model sees images and PDFs`);
    return [{ type: "image" as const, source: { type: "base64" as const, media_type: media, data } }, label];
  });
}

export interface StructuredResult<T> {
  output: T;
  usage: LlmUsage;
}

/** An LLM call that produced no usable output. Carries the usage, since a failed call still costs. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly usage: LlmUsage,
  ) {
    super(message);
  }
}

/** The step implementations' view of the LLM. */
export interface LlmClient {
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
}

/** Models without a server-side refusal fallback (docs/design.md §5). */
const NO_FALLBACK = /^claude-haiku-/;

/**
 * Claude through the Messages API, with structured output (docs/design.md §5): the response must match the zod schema or
 * the call fails with a clear error; nothing partial is returned. Sonnet and Opus calls fall back server-side on a
 * policy refusal.
 */
export class ClaudeClient implements LlmClient {
  constructor(private readonly client: Pick<Anthropic, "beta">) {}

  static fromApiKey(apiKey: string): ClaudeClient {
    return new ClaudeClient(new Anthropic({ apiKey }));
  }

  async structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const fallback = !NO_FALLBACK.test(request.choice.model);
    const response = await this.client.beta.messages.create({
      ...messageParams(request),
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    return checkedAnswer(request.schema, response, usageOf(request.choice.model, response.model, response.usage));
  }
}

/** One request of a batch; `customId` matches it to its result. */
export interface BatchRequest<S extends z.ZodObject> {
  customId: string;
  request: StructuredRequest<S>;
}

export type BatchItemResult<T> =
  { customId: string; ok: true; output: T; usage: LlmUsage } | { customId: string; ok: false; error: string; usage: LlmUsage };

/** Calls that can wait (docs/design.md §5: reflection): answered within 24 hours, at half the price. */
export interface LlmBatches {
  submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string>;
  /** True once every request has an answer (or failed, expired or was canceled). */
  ended(batchId: string): Promise<boolean>;
  /** The answers of an ended batch, each checked against `schema` like a direct call's. */
  results<S extends z.ZodObject>(batchId: string, schema: S, model: string): Promise<BatchItemResult<z.infer<S>>[]>;
}

/** The Message Batches API with the same structured output as ClaudeClient (no server-side fallback in batches). */
export class ClaudeBatches implements LlmBatches {
  constructor(private readonly client: Pick<Anthropic, "beta">) {}

  static fromApiKey(apiKey: string): ClaudeBatches {
    return new ClaudeBatches(new Anthropic({ apiKey }));
  }

  async submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string> {
    const batch = await this.client.beta.messages.batches.create({
      requests: requests.map(({ customId, request }) => ({ custom_id: customId, params: messageParams(request) })),
    });
    return batch.id;
  }

  async ended(batchId: string): Promise<boolean> {
    return (await this.client.beta.messages.batches.retrieve(batchId)).processing_status === "ended";
  }

  async results<S extends z.ZodObject>(batchId: string, schema: S, model: string): Promise<BatchItemResult<z.infer<S>>[]> {
    const results: BatchItemResult<z.infer<S>>[] = [];
    for await (const line of await this.client.beta.messages.batches.results(batchId)) {
      const customId = line.custom_id;
      if (line.result.type !== "succeeded") {
        const error = line.result.type === "errored" ? line.result.error.error.message : `The request ${line.result.type}`;
        results.push({ customId, ok: false, error, usage: emptyUsage() });
        continue;
      }
      const message = line.result.message;
      const usage = usageOf(model, message.model, message.usage, { batch: true });
      try {
        results.push({ customId, ok: true, ...checkedAnswer(schema, message, usage) });
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        results.push({ customId, ok: false, error: error.message, usage });
      }
    }
    return results;
  }
}

/** The Messages API parameters of a structured request. */
function messageParams<S extends z.ZodObject>(request: StructuredRequest<S>) {
  const { model, effort } = request.choice;
  // The helper's JSON schema constrains the answer; bounds and enums become hints there, so zod checks it after.
  // (messages.parse would throw on a mismatch and lose the response's usage: a failed call still costs.)
  return {
    model,
    max_tokens: request.maxTokens ?? 16_000,
    system: request.cacheSystem
      ? [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }]
      : request.system,
    messages: [
      {
        role: "user" as const,
        content:
          request.cachedPrompt || request.files?.length
            ? ([
                ...fileBlocks(request.files ?? []),
                ...(request.cachedPrompt ? [{ type: "text" as const, text: request.cachedPrompt, cache_control: { type: "ephemeral" as const } }] : []),
                ...(request.prompt ? [{ type: "text" as const, text: request.prompt }] : []),
              ] satisfies Anthropic.Beta.BetaContentBlockParam[])
            : request.prompt,
      },
    ],
    output_config: { effort, format: { type: "json_schema" as const, schema: betaZodOutputFormat(request.schema).schema } },
  };
}

/** The answer, if it is complete and matches the schema; otherwise an LlmError carrying the usage. */
function checkedAnswer<S extends z.ZodObject>(
  schema: S,
  response: Anthropic.Beta.BetaMessage,
  usage: LlmUsage,
): StructuredResult<z.infer<S>> {
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new LlmError(`The model declined the request${category ? ` (${category})` : ""}`, usage);
  }
  if (response.stop_reason === "max_tokens") throw new LlmError("The answer was cut off at the output limit", usage);
  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new LlmError("The model's answer did not match the expected format", usage);
  }
  const checked = schema.safeParse(answer);
  if (!checked.success) {
    const detail = checked.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ");
    throw new LlmError(`The model's answer did not match the expected format: ${detail}`, usage);
  }
  return { output: checked.data, usage };
}

type BetaUsage = Anthropic.Beta.BetaUsage;

/** The Batch API charges half of every token price. */
const BATCH_DISCOUNT = 0.5;

/** Usage and cost of one call. With a fallback, each model's share is priced at its own rate; batches cost half. */
export function usageOf(requested: string, served: string, usage: BetaUsage, options: { batch?: boolean } = {}): LlmUsage {
  const rate = options.batch ? BATCH_DISCOUNT : 1;
  const parts = (usage.iterations ?? [])
    .filter((entry) => entry.type === "message" || entry.type === "fallback_message")
    .map((entry) => ({
      model: ("model" in entry && entry.model) || requested,
      tokens: {
        inputTokens: entry.input_tokens,
        outputTokens: entry.output_tokens,
        cacheReadTokens: entry.cache_read_input_tokens,
        cacheWriteTokens: entry.cache_creation_input_tokens,
      },
    }));
  if (parts.length === 0) {
    parts.push({
      model: served || requested,
      tokens: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }
  return parts.reduce<LlmUsage>(
    (total, part) => addUsage(total, { models: [part.model], calls: 0, ...part.tokens, costUsd: costUsd(part.model, part.tokens) * rate }),
    { ...emptyUsage(), calls: 1 },
  );
}
