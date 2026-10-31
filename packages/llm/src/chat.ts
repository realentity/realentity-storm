import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { usageOf } from "./claude-client";
import { type ModelChoice } from "./models";
import { type LlmUsage } from "./usage";

/**
 * One content block as the API returned or expects it. Assistant blocks (thinking included) are stored and sent back
 * exactly as they came: Claude's thinking blocks are bound to the conversation, so history is append-only.
 */
export type ChatBlock = { type: string } & Record<string, unknown>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: ChatBlock[];
}

/** A tool the model may call; the caller runs it and answers with a tool_result block. */
export interface ChatTool {
  name: string;
  description: string;
  input: z.ZodObject;
}

export interface ChatRequest {
  choice: ModelChoice;
  /** Stable for the whole conversation (cached with the tools). */
  system: string;
  tools: ChatTool[];
  messages: ChatMessage[];
  maxTokens?: number;
}

export interface ChatResponse {
  content: ChatBlock[];
  /** end_turn, tool_use, max_tokens, refusal, … */
  stopReason: string | null;
  usage: LlmUsage;
}

/** A conversation with tools (README §2.1: the builder). */
export interface LlmChat {
  send(request: ChatRequest): Promise<ChatResponse>;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export function toolUses(content: ChatBlock[]): ToolUse[] {
  return content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ id: String(block.id), name: String(block.name), input: block.input }));
}

export function textOf(content: ChatBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("\n\n")
    .trim();
}

export function toolResult(toolUseId: string, content: string, isError = false): ChatBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

/**
 * The Messages API with tools. The system prompt and tools are cached, and so is the conversation so far (automatic
 * caching moves the breakpoint forward each call). No server-side fallback: another model's thinking blocks couldn't
 * be sent back to this one.
 */
export class ClaudeChat implements LlmChat {
  constructor(private readonly client: Pick<Anthropic, "beta">) {}

  static fromApiKey(apiKey: string): ClaudeChat {
    return new ClaudeChat(new Anthropic({ apiKey }));
  }

  async send(request: ChatRequest): Promise<ChatResponse> {
    const { model, effort } = request.choice;
    const response = await this.client.beta.messages.create({
      model,
      max_tokens: request.maxTokens ?? 16_000,
      system: [{ type: "text", text: request.system }],
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: inputSchema(tool.input) })),
      messages: request.messages as unknown as Anthropic.Beta.BetaMessageParam[],
      cache_control: { type: "ephemeral" },
      output_config: { effort },
    });
    return {
      content: response.content as unknown as ChatBlock[],
      stopReason: response.stop_reason,
      usage: usageOf(model, response.model, response.usage),
    };
  }
}

function inputSchema(schema: z.ZodObject): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as Anthropic.Beta.BetaTool.InputSchema;
}
