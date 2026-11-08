import { emptyUsage, type ChatBlock, type ChatRequest, type ChatResponse, type LlmChat } from "@realentity/storm-llm";

/** A move of the scripted agent: a tool and its input, worked out from the page it was last shown. */
export type Move = (page: string) => { name: string; input: Record<string, unknown> } | { name: string; input: Record<string, unknown> }[];

/**
 * The agent's model, scripted: each turn plays the next move against the latest <page> it was sent; after the script,
 * it keeps reading. Records every request (the model, the messages) for the assertions.
 */
export class ScriptedChat implements LlmChat {
  requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private moves: Move[] = []) {}

  play(moves: Move[]): void {
    this.moves = moves;
    this.turn = 0;
    this.requests = [];
  }

  send(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const move = this.moves[this.turn++] ?? (() => ({ name: "read", input: {} }));
    const uses = [move(latestPage(request))].flat();
    const content: ChatBlock[] = uses.map((use, i) => ({ type: "tool_use", id: `t${this.turn}-${i}`, name: use.name, input: use.input }));
    return Promise.resolve({ content, stopReason: "tool_use", usage: { ...emptyUsage(), calls: 1, costUsd: 0.01, models: [request.choice.model] } });
  }

  /** What the agent was told after each action (tool results), in order, across conversations (an escalation starts one). */
  results(): string[] {
    const seen = new Map<string, string>();
    for (const request of this.requests) {
      for (const block of request.messages.flatMap((m) => m.content)) {
        if (block.type !== "tool_result") continue;
        seen.set(String(block.tool_use_id), typeof block.content === "string" ? block.content : JSON.stringify(block.content));
      }
    }
    return [...seen.values()];
  }
}

function latestPage(request: ChatRequest): string {
  const texts = request.messages.flatMap((m) =>
    m.content.flatMap((b) => (b.type === "text" ? [String(b.text)] : b.type === "tool_result" && typeof b.content === "string" ? [b.content] : [])),
  );
  for (const text of texts.reverse()) {
    const at = text.lastIndexOf("<page ");
    if (at >= 0) return text.slice(at);
  }
  return "";
}

/** The ref of the outline line with this role whose name matches. */
export function ref(page: string, role: string, name: RegExp): string {
  for (const line of page.split("\n")) {
    const match = /^\[(e\d+)\] (\S+) "([^"]*)"/.exec(line);
    if (match && match[2] === role && name.test(match[3])) return match[1];
  }
  throw new Error(`No ${role} ${name} in the page:\n${page}`);
}

export const click = (role: string, name: RegExp): Move => (page) => ({ name: "click", input: { ref: ref(page, role, name) } });
export const type = (name: RegExp, text: string): Move => (page) => ({ name: "type", input: { ref: ref(page, "textbox", name), text, source: "profile" } });
