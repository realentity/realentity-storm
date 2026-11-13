import { CLAUDE_MODELS } from "@realentity/storm-shared";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeClient, LlmError, usageOf } from "./claude-client";
import { ModelRouter } from "./models";
import { costUsd, isPriced } from "./usage";

const Answer = z.object({ label: z.enum(["keep", "drop"]), reason: z.string().min(3) });

const usage = (input = 1000, output = 200): Anthropic.Beta.BetaUsage =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    iterations: null,
  }) as Anthropic.Beta.BetaUsage;

/** A Messages API stand-in; `answer` is the model's text (JSON, or not). */
function fakeClient(response: { stop_reason: string; answer?: unknown; stop_details?: unknown }) {
  const { answer, ...rest } = response;
  const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? {});
  const create = jest.fn().mockResolvedValue({
    model: "claude-haiku-5-5",
    stop_details: null,
    usage: usage(),
    content: [{ type: "text", text }],
    ...rest,
  });
  const client = new ClaudeClient({ beta: { messages: { create } } } as unknown as Pick<Anthropic, "beta">);
  return { client, create };
}

const firstCall = (create: jest.Mock): Record<string, unknown> => (create.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;

const request = (model = "claude-haiku-5-5") => ({
  choice: { model, effort: "low" as const },
  system: "Label the item.",
  prompt: "<item>Senior .NET</item>",
  schema: Answer,
});

describe("ClaudeClient", () => {
  it("returns the validated answer with the call's usage and cost", async () => {
    const { client, create } = fakeClient({ stop_reason: "end_turn", answer: { label: "keep", reason: "fits the profile" } });
    const result = await client.structured(request());

    expect(result.output).toEqual({ label: "keep", reason: "fits the profile" });
    expect(result.usage).toEqual({
      models: ["claude-haiku-5-5"],
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0002,
    });
    const params = firstCall(create);
    expect(params).toMatchObject({
      model: "claude-haiku-5-5",
      system: "Label the item.",
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", required: ["label", "reason"] } } },
    });
    // Haiku has no server-side fallback.
    expect(params).not.toHaveProperty("fallbacks");
  });

  it("asks for the server-side refusal fallback on Sonnet and Opus", async () => {
    const { client, create } = fakeClient({ stop_reason: "end_turn", answer: { label: "drop", reason: "too junior" } });
    await client.structured(request("claude-sonnet-5-5"));
    expect(firstCall(create)).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  });

  // M4-T5
  // M46-T3
  it("sends images and PDFs before the prompt, each named; refuses another kind of file", async () => {
    const { client, create } = fakeClient({ stop_reason: "end_turn", answer: { label: "keep", reason: "a receipt" } });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const pdf = Buffer.from("%PDF-1.4");
    await client.structured({
      ...request(),
      files: [
        { name: "scan.png", mime: "image/png", data: png },
        { name: 'receipt "1".pdf', mime: "application/pdf", data: pdf },
      ],
    });
    expect((firstCall(create).messages as { content: unknown }[])[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      { type: "text", text: '<file index="0" name="scan.png"/>' },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
      { type: "text", text: '<file index="1" name="receipt 1.pdf"/>' },
      { type: "text", text: "<item>Senior .NET</item>" },
    ]);
    await expect(client.structured({ ...request(), files: [{ name: "a.docx", mime: "application/zip", data: pdf }] })).rejects.toThrow(
      "a.docx is a application/zip file: the model sees images and PDFs",
    );
  });

  it("marks the system prompt for caching when asked", async () => {
    const { client, create } = fakeClient({ stop_reason: "end_turn", answer: { label: "keep", reason: "fits the profile" } });
    await client.structured({ ...request(), cacheSystem: true });
    expect(firstCall(create)).toMatchObject({
      system: [{ type: "text", text: "Label the item.", cache_control: { type: "ephemeral" } }],
    });
  });

  // M2-U6
  it("fails with a clear error, and no output, when the answer doesn't match the schema", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", answer: "Sure! Here is the label: keep" });
    const error = await client.structured(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toBe("The model's answer did not match the expected format");
    // The failed call still cost something: the usage travels with the error.
    expect((error as LlmError).usage.costUsd).toBeGreaterThan(0);

    const { client: refined } = fakeClient({ stop_reason: "end_turn", answer: { label: "keep", reason: "ok" } });
    await expect(refined.structured(request())).rejects.toThrow(/did not match the expected format: reason/);
  });

  it("fails on a refusal (with its category) and on an answer cut off at the output limit", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } });
    await expect(client.structured(request())).rejects.toThrow("The model declined the request (cyber)");
    const { client: cut } = fakeClient({ stop_reason: "max_tokens", answer: '{"label": "ke' });
    await expect(cut.structured(request())).rejects.toThrow("The answer was cut off at the output limit");
  });
});

describe("usage and cost", () => {
  it("prices each model's share of a call that fell back", () => {
    const withFallback = {
      ...usage(),
      iterations: [
        {
          type: "message",
          model: "claude-sonnet-5-5",
          input_tokens: 1000,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        {
          type: "fallback_message",
          model: "claude-opus-4-8",
          input_tokens: 1000,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    } as unknown as Anthropic.Beta.BetaUsage;
    const result = usageOf("claude-sonnet-5-5", "claude-opus-4-8", withFallback);
    expect(result.models).toEqual(["claude-sonnet-5-5", "claude-opus-4-8"]);
    expect(result.inputTokens).toBe(2000);
    expect(result.costUsd).toBeCloseTo(0.0021 + 0.0125, 6);
  });

  it("counts cache reads and writes, and charges an unknown model the highest known rate", () => {
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toBe(
      0.2 + 2.5,
    );
    expect(costUsd("claude-future-9", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(10);
  });
});

describe("ModelRouter", () => {
  it("uses the user's setting for the task, else the environment's model for its group, else the default", async () => {
    const settings: Record<string, { model: string; effort: string | null }> = {
      "llm.generate": { model: "claude-opus-5-5", effort: "high" },
      "llm.summarize": { model: "claude-haiku-5-5", effort: "lots" },
    };
    const router = new ModelRouter(async (_userId, task) => settings[task] ?? null, { LLM_MODEL_CLASSIFY: "claude-sonnet-5-5" });

    await expect(router.choose("u", "llm.generate")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high" });
    await expect(router.choose("u", "llm.summarize")).resolves.toEqual({ model: "claude-haiku-5-5", effort: "medium" });
    await expect(router.choose("u", "llm.score")).resolves.toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    await expect(new ModelRouter(async () => null).choose("u", "llm.classify")).resolves.toEqual({
      model: "claude-haiku-5-5",
      effort: "low",
    });
  });

  it("tells where a task's model comes from without a setting", () => {
    const router = new ModelRouter(async () => null, { LLM_MODEL_CLASSIFY: "claude-sonnet-5-5" });
    expect(router.fallback("llm.score")).toEqual({ model: "claude-sonnet-5-5", effort: "low", source: "env" });
    expect(router.fallback("llm.generate")).toEqual({ model: "claude-sonnet-5-5", effort: "medium", source: "default" });
  });

  it("has a price for every model Settings offers", () => {
    expect(CLAUDE_MODELS.filter((model) => !isPriced(model))).toEqual([]);
  });
});
