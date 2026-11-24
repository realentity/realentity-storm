import { z } from "zod";
import { type ChatBlock, type ChatMessage, type ChatRequest, type ChatResponse, type LlmChat } from "./chat";
import { LlmError, type LlmClient, type LlmFile, type StructuredRequest, type StructuredResult } from "./claude-client";
import { addUsage, costUsd, emptyUsage, type LlmUsage } from "./usage";

/**
 * M60: models on an OpenAI-compatible server (docs/design.md §5): Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, OpenAI.
 * Their model ids carry this prefix (`openai:qwen3:14b`); a model without it is Claude's.
 */
export const OPENAI_PREFIX = "openai:";

export function isOpenAiModel(model: string): boolean {
  return model.startsWith(OPENAI_PREFIX);
}

/** The model's name on the server: the id without the prefix. */
export function serverModel(model: string): string {
  return isOpenAiModel(model) ? model.slice(OPENAI_PREFIX.length) : model;
}

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiServer {
  /** Up to and including `/v1`, e.g. http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  /** Optional for a local server. Never in an error message. */
  apiKey?: string;
  /** A model on a CPU can take minutes for one answer. */
  timeoutMs?: number;
  send?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The server's HTTP API: one request, its JSON answer, errors that name the server's host but never the key. */
export class OpenAiApi {
  private readonly baseUrl: string;
  private readonly send: typeof fetch;

  constructor(private readonly server: OpenAiServer) {
    this.baseUrl = server.baseUrl.replace(/\/+$/, "");
    this.send = server.send ?? fetch;
  }

  /** The host the errors name: no path, no credentials in the URL. */
  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return "the model server";
    }
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    let response: Response;
    try {
      response = await this.send(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.server.apiKey ? { authorization: `Bearer ${this.server.apiKey}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs ?? this.server.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new Error(timedOut ? `The model server (${this.host}) didn't answer in time` : `The model server (${this.host}) could not be reached`);
    }
    const text = await response.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const detail = errorMessage(json) ?? text.slice(0, 200).trim();
      throw new Error(`The model server (${this.host}) refused the request (${response.status}${detail ? `: ${redact(detail, this.server.apiKey)}` : ""})`);
    }
    if (json === undefined) throw new Error(`The model server (${this.host}) answered with something that isn't JSON`);
    return json as T;
  }

  /** The server's models, without the prefix (GET /models). */
  async models(): Promise<string[]> {
    const body = await this.request<{ data?: { id?: unknown }[] }>("GET", "/models", undefined, 15_000);
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
  }
}

function errorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const error = (json as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return undefined;
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("…") : text;
}

/** The parts of a chat completions request and answer Storm uses. */
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Part[] }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface Completion {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null; tool_calls?: Partial<OaiToolCall>[] | null };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * The files as message parts. Images go as data URLs (a model that can't see them answers without them: choose a vision
 * model for an App that reads scans). PDFs aren't part of the protocol most local servers speak, so they fail clearly
 * instead of being dropped without a word.
 */
function fileParts(files: LlmFile[]): Part[] {
  return files.flatMap((file, index): Part[] => {
    if (file.mime === "application/pdf") {
      throw new Error(`${file.name} is a PDF: a model on an OpenAI-compatible server reads images only (a scan as JPEG or PNG)`);
    }
    if (!IMAGE_TYPES.includes(file.mime)) throw new Error(`${file.name} is a ${file.mime} file: the model sees images`);
    return [
      { type: "image_url", image_url: { url: `data:${file.mime};base64,${file.data.toString("base64")}` } },
      { type: "text", text: `<file index="${index}" name="${file.name.replace(/[<>"]/g, "")}"/>` },
    ];
  });
}

/** Reasoning models on some servers put their thinking in the answer: it isn't part of it. */
function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** The JSON in an answer: some models wrap it in a code fence even when asked for JSON only. */
function jsonText(text: string): string {
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

function usageOfCompletion(model: string, completion: Completion): LlmUsage {
  const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const tokens = {
    inputTokens: Math.max(0, (completion.usage?.prompt_tokens ?? 0) - cached),
    outputTokens: completion.usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
  return { models: [model], calls: 1, ...tokens, costUsd: costUsd(model, tokens) };
}

function jsonSchemaOf(schema: z.ZodObject, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return json;
}

/**
 * Structured output on an OpenAI-compatible server: the zod schema as `response_format`, the answer checked with zod as
 * Claude's is. Small models get it wrong more often, so a wrong answer is asked for once more, with what was wrong;
 * both calls are counted. Effort isn't sent (servers differ in what they accept), and nothing is cached.
 */
export class OpenAiClient implements LlmClient {
  constructor(private readonly api: OpenAiApi) {}

  async structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const model = request.choice.model;
    const text = [request.cachedPrompt, request.prompt].filter(Boolean).join("\n\n");
    let parts: Part[] | undefined;
    try {
      parts = request.files?.length ? [...fileParts(request.files), { type: "text", text }] : undefined;
    } catch (error) {
      throw new LlmError((error as Error).message, emptyUsage());
    }
    const messages: OaiMessage[] = [
      { role: "system", content: request.system },
      { role: "user", content: parts ?? text },
    ];
    const params = {
      model: serverModel(model),
      max_tokens: request.maxTokens ?? 16_000,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: jsonSchemaOf(request.schema, "output") } },
    };

    let usage = emptyUsage();
    for (let attempt = 1; ; attempt++) {
      const completion = await this.api.request<Completion>("POST", "/chat/completions", { ...params, messages });
      usage = addUsage(usage, usageOfCompletion(model, completion));
      const choice = completion.choices?.[0];
      if (choice?.message?.refusal) throw new LlmError(`The model declined the request: ${choice.message.refusal}`, usage);
      if (choice?.finish_reason === "length") throw new LlmError("The answer was cut off at the output limit", usage);
      if (choice?.finish_reason === "content_filter") throw new LlmError("The model declined the request (content filter)", usage);
      const answer = withoutThinking(choice?.message?.content ?? "");
      const problem = checkAnswer(request.schema, answer);
      if (problem.ok) return { output: problem.output, usage };
      if (attempt >= 2) throw new LlmError(`The model's answer did not match the expected format${problem.detail ? `: ${problem.detail}` : ""}`, usage);
      messages.push(
        { role: "assistant", content: answer },
        {
          role: "user",
          content: `That answer doesn't match the format${problem.detail ? ` (${problem.detail})` : ""}. Answer again with only the JSON object.`,
        },
      );
    }
  }
}

function checkAnswer<S extends z.ZodObject>(schema: S, text: string): { ok: true; output: z.infer<S> } | { ok: false; detail: string } {
  let answer: unknown;
  try {
    answer = JSON.parse(jsonText(text));
  } catch {
    return { ok: false, detail: text ? "not valid JSON" : "empty" };
  }
  const checked = schema.safeParse(answer);
  if (checked.success) return { ok: true, output: checked.data };
  return { ok: false, detail: checked.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ") };
}

/**
 * Chat with tools on an OpenAI-compatible server (the builder, `browser.agent`). The conversation stays in Claude's
 * block format (stored as it is); it is translated on the way out and the answer back into blocks: text and tool_use.
 * Thinking blocks of an earlier Claude turn aren't sent.
 */
export class OpenAiChat implements LlmChat {
  constructor(private readonly api: OpenAiApi) {}

  async send(request: ChatRequest): Promise<ChatResponse> {
    const model = request.choice.model;
    const completion = await this.api.request<Completion>("POST", "/chat/completions", {
      model: serverModel(model),
      max_tokens: request.maxTokens ?? 16_000,
      messages: [{ role: "system", content: request.system }, ...toOpenAiMessages(request.messages)],
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: jsonSchemaOf(tool.input, "input") },
            })),
          }
        : {}),
    });
    const choice = completion.choices?.[0];
    const content: ChatBlock[] = [];
    const text = withoutThinking(choice?.message?.content ?? "");
    if (text) content.push({ type: "text", text });
    (choice?.message?.tool_calls ?? []).forEach((call, index) => {
      content.push({
        type: "tool_use",
        id: call.id || `call_${Date.now().toString(36)}_${index}`,
        name: call.function?.name ?? "",
        input: parseArguments(call.function?.arguments),
      });
    });
    const usage = usageOfCompletion(model, completion);
    if (choice?.message?.refusal) return { content: [{ type: "text", text: choice.message.refusal }], stopReason: "refusal", usage };
    return { content, stopReason: stopReason(choice?.finish_reason, content), usage };
  }
}

/** A tool call's arguments as the tool's input: what doesn't parse stays the raw text, so the tool's check says so. */
function parseArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function stopReason(finish: string | null | undefined, content: ChatBlock[]): string {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  // Some servers say "stop" even when the answer has tool calls.
  if (finish === "tool_calls" || content.some((b) => b.type === "tool_use")) return "tool_use";
  return "end_turn";
}

/**
 * Claude's blocks as chat completions messages. A user turn's tool results become `tool` messages first (they must follow
 * the assistant's calls); images in a tool result, which a `tool` message can't carry, follow in a user message.
 */
export function toOpenAiMessages(messages: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => String(b.text))
        .join("\n\n");
      const calls: OaiToolCall[] = message.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts: Part[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const { text, images } = resultContent(block.content);
        out.push({ role: "tool", tool_call_id: String(block.tool_use_id), content: `${block.is_error ? "Error: " : ""}${text}` });
        parts.push(...images);
      } else if (block.type === "text") {
        parts.push({ type: "text", text: String(block.text) });
      } else if (block.type === "image") {
        const image = imagePart(block);
        if (image) parts.push(image);
      }
    }
    if (parts.length === 0) continue;
    out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts });
  }
  return out;
}

function resultContent(content: unknown): { text: string; images: Part[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const blocks = content as ChatBlock[];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join("\n\n");
  const images = blocks.map(imagePart).filter((p): p is Part => p !== null);
  return { text, images };
}

function imagePart(block: ChatBlock): Part | null {
  if (block.type !== "image") return null;
  const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
  if (source?.type !== "base64" || !source.data) return null;
  return { type: "image_url", image_url: { url: `data:${source.media_type ?? "image/jpeg"};base64,${source.data}` } };
}
