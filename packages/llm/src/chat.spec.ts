import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeChat, textOf, toolResult, toolUses, type ChatMessage } from "./chat";

function fakeClient(content: unknown[], stop_reason = "end_turn") {
  const create = jest.fn().mockResolvedValue({
    model: "claude-opus-5-5",
    stop_reason,
    content,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, iterations: null },
  });
  return { chat: new ClaudeChat({ beta: { messages: { create } } } as unknown as Pick<Anthropic, "beta">), create };
}

describe("ClaudeChat", () => {
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "Draft replies" }] }];
  const tools = [
    {
      name: "propose_pipeline",
      description: "Propose it",
      input: z.object({ summary: z.string(), pipeline: z.record(z.string(), z.unknown()) }),
    },
  ];

  it("sends tools as JSON Schema, caches the conversation, and returns the blocks as they came", async () => {
    const blocks = [
      { type: "thinking", thinking: "", signature: "abc" },
      { type: "tool_use", id: "toolu_1", name: "propose_pipeline", input: { summary: "x", pipeline: {} } },
    ];
    const { chat, create } = fakeClient(blocks, "tool_use");
    const response = await chat.send({ choice: { model: "claude-opus-5-5", effort: "high" }, system: "Build pipelines.", tools, messages });

    const params = (create.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "Build pipelines." }],
      cache_control: { type: "ephemeral" },
      output_config: { effort: "high" },
      messages,
    });
    // No server-side fallback: another model's thinking couldn't be replayed to this one.
    expect(params).not.toHaveProperty("fallbacks");
    expect(params.tools).toEqual([
      {
        name: "propose_pipeline",
        description: "Propose it",
        input_schema: expect.objectContaining({ type: "object", required: ["summary", "pipeline"] }) as unknown,
      },
    ]);
    expect(JSON.stringify(params.tools)).not.toContain("$schema");
    expect(response.content).toBe(blocks);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toMatchObject({ calls: 1, inputTokens: 1000, cacheReadTokens: 4000, costUsd: 0.0068 });
  });

  it("reads tool calls and text, and builds tool results", () => {
    const content = [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "t1", name: "list_runs", input: {} },
      { type: "text", text: "Done." },
    ];
    expect(toolUses(content)).toEqual([{ id: "t1", name: "list_runs", input: {} }]);
    expect(textOf(content)).toBe("Checking.\n\nDone.");
    expect(toolResult("t1", "nope", true)).toEqual({ type: "tool_result", tool_use_id: "t1", content: "nope", is_error: true });
    expect(toolResult("t1", "ok")).not.toHaveProperty("is_error");
  });
});
