import { type ChatBlock, type ChatRequest, type ChatResponse, type LlmChat, type LlmUsage } from "@ai-me/llm";

/** One scripted model call: what it answers, given what it was sent. */
export type Reply = (request: ChatRequest) => ChatResponse;

/**
 * The builder's LLM in tests: answers from a script, one entry per call, and keeps every request (its messages
 * copied as sent) so a test can check what the model saw.
 */
export class ScriptedChat implements LlmChat {
  readonly requests: ChatRequest[] = [];
  private script: Reply[] = [];

  /** Replaces what the next calls answer. */
  answer(...replies: Reply[]): this {
    this.script = [...replies];
    return this;
  }

  send(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const next = this.script.shift();
    if (!next) return Promise.reject(new Error("The script has no more answers"));
    try {
      return Promise.resolve(next(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  get last(): ChatRequest {
    const last = this.requests.at(-1);
    if (!last) throw new Error("No request yet");
    return last;
  }

  reset(): void {
    this.requests.length = 0;
    this.script = [];
  }
}

export function usage(tokens = 1000): LlmUsage {
  return {
    models: ["claude-opus-5-5"],
    calls: 1,
    inputTokens: tokens,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  };
}

let ids = 0;

/** The model calls one or more tools. */
export function callTools(...calls: { name: string; input: unknown }[]): Reply {
  return () => ({
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      ...calls.map((c): ChatBlock => ({ type: "tool_use", id: `toolu_${++ids}`, name: c.name, input: c.input })),
    ],
    stopReason: "tool_use",
    usage: usage(),
  });
}

export const propose = (pipeline: unknown, summary = "A pipeline"): Reply =>
  callTools({ name: "propose_pipeline", input: { summary, pipeline } });

/** The model ends its turn with text. */
export function say(text: string): Reply {
  return () => ({ content: [{ type: "text", text, citations: null }], stopReason: "end_turn", usage: usage() });
}

/** The tool results the builder sent back in a request (the last user message). */
export function toolResults(request: ChatRequest): { content: string; is_error?: boolean }[] {
  const last = request.messages.at(-1);
  return (last?.content ?? []).filter((b) => b.type === "tool_result") as unknown as { content: string; is_error?: boolean }[];
}

/** Text of the user message I sent in a turn (the first message after the history). */
export function userText(request: ChatRequest): string {
  const users = request.messages.filter((m) => m.role === "user" && m.content.some((b) => b.type === "text"));
  const block = users.at(-1)?.content.find((b) => b.type === "text");
  return typeof block?.text === "string" ? block.text : "";
}
