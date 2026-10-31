import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeBatches } from "./claude-client";
import { EMBEDDING_DIMENSIONS, OpenAiEmbeddings } from "./embeddings";
import { costUsd } from "./usage";

const Answer = z.object({ rules: z.array(z.string()).max(2) });

const message = (answer: unknown, stop_reason = "end_turn") => ({
  model: "claude-opus-5-5",
  stop_reason,
  stop_details: null,
  content: [{ type: "text", text: JSON.stringify(answer) }],
  usage: { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: null },
});

/** A Message Batches stand-in: `lines` are the results file. */
function fakeBatches(lines: unknown[], status = "ended") {
  const create = jest.fn().mockResolvedValue({ id: "msgbatch_1" });
  const retrieve = jest.fn().mockResolvedValue({ processing_status: status });
  const results = jest.fn().mockResolvedValue(
    (async function* () {
      yield* lines;
    })(),
  );
  const batches = new ClaudeBatches({ beta: { messages: { batches: { create, retrieve, results } } } } as unknown as Pick<
    Anthropic,
    "beta"
  >);
  return { batches, create, retrieve, results };
}

const request = {
  choice: { model: "claude-opus-5-5", effort: "high" as const },
  system: "Suggest rules.",
  prompt: "<decisions>…</decisions>",
  schema: Answer,
};

describe("ClaudeBatches", () => {
  it("submits structured requests with the same parameters as a direct call, keyed by custom id", async () => {
    const { batches, create } = fakeBatches([]);
    await expect(batches.submit([{ customId: "r-1", request }])).resolves.toBe("msgbatch_1");
    const [params] = (create.mock.calls as unknown[][])[0] as [{ requests: { custom_id: string; params: Record<string, unknown> }[] }];
    expect(params.requests).toHaveLength(1);
    expect(params.requests[0]).toMatchObject({
      custom_id: "r-1",
      params: {
        model: "claude-opus-5-5",
        system: "Suggest rules.",
        messages: [{ role: "user", content: "<decisions>…</decisions>" }],
        output_config: { effort: "high", format: { type: "json_schema" } },
      },
    });
  });

  it("reports whether the batch has ended", async () => {
    await expect(fakeBatches([], "in_progress").batches.ended("msgbatch_1")).resolves.toBe(false);
    await expect(fakeBatches([], "ended").batches.ended("msgbatch_1")).resolves.toBe(true);
  });

  it("checks each answer against the schema and prices it at half the direct rate", async () => {
    const { batches } = fakeBatches([
      { custom_id: "ok", result: { type: "succeeded", message: message({ rules: ["Be brief."] }) } },
      { custom_id: "bad", result: { type: "succeeded", message: message({ rules: ["a", "b", "c"] }) } },
      { custom_id: "err", result: { type: "errored", error: { type: "error", error: { type: "api_error", message: "Overloaded" } } } },
      { custom_id: "late", result: { type: "expired" } },
    ]);
    const results = await batches.results("msgbatch_1", Answer, "claude-opus-5-5");
    const direct = costUsd("claude-opus-5-5", { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 });

    expect(results[0]).toMatchObject({ customId: "ok", ok: true, output: { rules: ["Be brief."] } });
    expect(results[0].usage.costUsd).toBeCloseTo(direct / 2, 6);
    expect(results[1]).toMatchObject({ customId: "bad", ok: false });
    expect(results[1].ok ? "" : results[1].error).toContain("expected format");
    expect(results[1].usage.costUsd).toBeGreaterThan(0);
    expect(results[2]).toMatchObject({ customId: "err", ok: false, error: "Overloaded" });
    expect(results[3]).toMatchObject({ customId: "late", ok: false, error: "The request expired" });
  });
});

describe("OpenAiEmbeddings", () => {
  const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed ? 1 : 0));

  it("asks for 1024 dimensions, returns vectors in input order, and prices the tokens", async () => {
    const send = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector(1) },
            { index: 0, embedding: vector(0) },
          ],
          usage: { prompt_tokens: 1_000_000 },
        }),
        { status: 200 },
      ),
    );
    const embeddings = new OpenAiEmbeddings("sk-test", "text-embedding-3-large", send);
    const { vectors, usage } = await embeddings.embed(["first", "second"]);

    expect(vectors[0][0]).toBe(1);
    expect(vectors[1][1]).toBe(1);
    expect(usage).toMatchObject({ models: ["text-embedding-3-large"], calls: 1, inputTokens: 1_000_000, costUsd: 0.13 });
    const [url, init] = (send.mock.calls as [string, RequestInit][])[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(JSON.parse(init.body as string)).toEqual({ model: "text-embedding-3-large", input: ["first", "second"], dimensions: 1024 });
  });

  it("errors say what went wrong, never the key; a wrong shape is refused", async () => {
    const refused = new OpenAiEmbeddings(
      "sk-secret",
      "text-embedding-3-large",
      jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })),
    );
    await expect(refused.embed(["x"])).rejects.toThrow("OpenAI refused the embeddings request (401: Incorrect API key)");
    await expect(refused.embed(["x"])).rejects.not.toThrow(/sk-secret/);

    const offline = new OpenAiEmbeddings(
      "sk-secret",
      "text-embedding-3-large",
      jest.fn().mockRejectedValue(new Error("ECONNREFUSED sk-secret")),
    );
    await expect(offline.embed(["x"])).rejects.toThrow(/^OpenAI could not be reached$/);

    const short = new OpenAiEmbeddings(
      "k",
      "text-embedding-3-large",
      jest.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 })),
    );
    await expect(short.embed(["x"])).rejects.toThrow("wrong shape");
  });

  it("embeds nothing for no texts", async () => {
    const send = jest.fn();
    await expect(new OpenAiEmbeddings("k", "text-embedding-3-small", send).embed([])).resolves.toMatchObject({ vectors: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
