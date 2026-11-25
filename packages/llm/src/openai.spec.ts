import { z } from "zod";
import { LlmError, type LlmClient } from "./claude-client";
import { ModelRouter } from "./models";
import { OpenAiApi, OpenAiChat, OpenAiClient, toOpenAiMessages } from "./openai";
import { RoutedBatches, RoutedChat, RoutedClient, SequentialBatches, llmConfigured, llmFromConfig, openAiApi } from "./providers";
import { costUsd } from "./usage";

/** A fake OpenAI-compatible server: answers in order, records each request. */
function fakeServer(...answers: (object | ((body: Record<string, unknown>) => Response) | Error)[]) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const send = jest.fn((url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url, init: init ?? {}, body });
    const answer = answers.shift();
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === "function") return Promise.resolve(answer(body));
    return Promise.resolve(new Response(JSON.stringify(answer ?? {}), { status: 200 }));
  });
  return { send: send as unknown as typeof fetch, requests };
}

function completion(content: string | null, extra: Record<string, unknown> = {}, finish = "stop") {
  return {
    model: "qwen3:14b",
    choices: [{ finish_reason: finish, message: { role: "assistant", content, ...extra } }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
}

const KEY = "test-key-not-real";
const schema = z.object({ category: z.enum(["bill", "other"]), amount: z.number().nullable() });
const choice = { model: "openai:qwen3:14b", effort: "low" as const };

function client(server: ReturnType<typeof fakeServer>, apiKey?: string) {
  return new OpenAiClient(new OpenAiApi({ baseUrl: "http://localhost:11434/v1/", apiKey, send: server.send }));
}

describe("OpenAiClient", () => {
  it("asks for the schema, sends the model's name without the prefix, and returns the checked answer at no cost", async () => {
    const server = fakeServer(completion('{"category":"bill","amount":12.5}'));
    const result = await client(server).structured({ choice, system: "Classify.", prompt: "<email>Pay 12.50</email>", schema });

    expect(result.output).toEqual({ category: "bill", amount: 12.5 });
    expect(result.usage).toEqual({
      models: ["openai:qwen3:14b"],
      calls: 1,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    const [request] = server.requests;
    expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(request.init.headers).not.toHaveProperty("authorization");
    expect(request.body).toMatchObject({
      model: "qwen3:14b",
      max_tokens: 16_000,
      messages: [
        { role: "system", content: "Classify." },
        { role: "user", content: "<email>Pay 12.50</email>" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema: expect.objectContaining({ type: "object", required: ["category", "amount"] }) as unknown },
      },
    });
    expect(JSON.stringify(request.body)).not.toContain("$schema");
    // Effort isn't sent: servers differ in what they accept.
    expect(request.body).not.toHaveProperty("reasoning_effort");
  });

  it("sends the key as a bearer token when there is one", async () => {
    const server = fakeServer(completion('{"category":"other","amount":null}'));
    await client(server, KEY).structured({ choice, system: "s", prompt: "p", schema });
    expect(server.requests[0].init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it("reads an answer with thinking before it or in a code fence", async () => {
    const server = fakeServer(
      completion('<think>It mentions paying.</think>\n{"category":"bill","amount":3}'),
      completion('```json\n{"category":"other","amount":null}\n```'),
    );
    expect((await client(server).structured({ choice, system: "s", prompt: "p", schema })).output).toEqual({ category: "bill", amount: 3 });
    expect((await client(server).structured({ choice, system: "s", prompt: "p", schema })).output).toEqual({ category: "other", amount: null });
  });

  it("asks once more with what was wrong, and counts both calls", async () => {
    const server = fakeServer(completion('{"category":"invoice","amount":1}'), completion('{"category":"bill","amount":1}'));
    const result = await client(server).structured({ choice, system: "s", prompt: "p", schema });

    expect(result.output).toEqual({ category: "bill", amount: 1 });
    expect(result.usage).toMatchObject({ calls: 2, inputTokens: 240, outputTokens: 60 });
    const retry = server.requests[1].body.messages as { role: string; content: string }[];
    expect(retry.slice(2)).toEqual([
      { role: "assistant", content: '{"category":"invoice","amount":1}' },
      { role: "user", content: expect.stringContaining("category") as unknown },
    ]);
  });

  it("fails with what was wrong after the second wrong answer, carrying the usage", async () => {
    const server = fakeServer(completion("I think it's a bill."), completion("A bill, 12.50."));
    const error = await client(server)
      .structured({ choice, system: "s", prompt: "p", schema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toBe("The model's answer did not match the expected format: not valid JSON");
    expect((error as LlmError).usage.calls).toBe(2);
  });

  it("doesn't retry an answer cut off at the limit or a refusal", async () => {
    const cut = fakeServer(completion('{"category":', {}, "length"));
    await expect(client(cut).structured({ choice, system: "s", prompt: "p", schema })).rejects.toThrow("cut off at the output limit");
    expect(cut.requests).toHaveLength(1);

    const refused = fakeServer(completion(null, { refusal: "Not this." }));
    await expect(client(refused).structured({ choice, system: "s", prompt: "p", schema })).rejects.toThrow("declined the request: Not this.");
  });

  it("sends images as data URLs before the prompt, and refuses a PDF instead of dropping it", async () => {
    const server = fakeServer(completion('{"category":"bill","amount":null}'));
    const image = { name: "scan.png", mime: "image/png", data: Buffer.from("png") };
    await client(server).structured({ choice, system: "s", prompt: "Read it", cachedPrompt: "Context", schema, files: [image] });
    expect((server.requests[0].body.messages as unknown[])[1]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("png").toString("base64")}` } },
        { type: "text", text: '<file index="0" name="scan.png"/>' },
        { type: "text", text: "Context\n\nRead it" },
      ],
    });

    const pdf = { name: "contract.pdf", mime: "application/pdf", data: Buffer.from("%PDF") };
    const none = fakeServer();
    await expect(client(none).structured({ choice, system: "s", prompt: "p", schema, files: [pdf] })).rejects.toThrow(
      "contract.pdf is a PDF: a model on an OpenAI-compatible server reads images only",
    );
    expect(none.requests).toHaveLength(0);
  });

  it("says what the server refused, naming the host but never the key", async () => {
    const server = fakeServer(
      () => new Response(JSON.stringify({ error: { message: `model "qwen3:14b" not found (key ${KEY})` } }), { status: 404 }),
      new TypeError("fetch failed"),
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
      () => new Response("<html>Bad gateway</html>", { status: 200 }),
    );
    const call = () => client(server, KEY).structured({ choice, system: "s", prompt: "p", schema });
    const messages = [];
    for (let i = 0; i < 4; i++) messages.push(((await call().catch((e: unknown) => e)) as Error).message);
    expect(messages).toEqual([
      'The model server (localhost:11434) refused the request (404: model "qwen3:14b" not found (key …))',
      "The model server (localhost:11434) could not be reached",
      "The model server (localhost:11434) didn't answer in time",
      "The model server (localhost:11434) answered with something that isn't JSON",
    ]);
    expect(messages.join(" ")).not.toContain(KEY);
  });
});

describe("OpenAiApi.models", () => {
  it("lists the server's models, sorted", async () => {
    const server = fakeServer({ object: "list", data: [{ id: "qwen3:14b" }, { id: "gemma3:12b" }, { id: 7 }] });
    const api = new OpenAiApi({ baseUrl: "http://localhost:11434/v1", send: server.send });
    expect(await api.models()).toEqual(["gemma3:12b", "qwen3:14b"]);
    expect(server.requests[0]).toMatchObject({ url: "http://localhost:11434/v1/models", init: { method: "GET" } });
  });
});

describe("OpenAiChat", () => {
  const tools = [{ name: "click", description: "Click an element", input: z.object({ ref: z.string() }) }];

  it("sends the tools as functions and the conversation translated, and answers in blocks", async () => {
    const server = fakeServer(
      completion("Clicking.", {
        tool_calls: [{ id: "call_1", type: "function", function: { name: "click", arguments: '{"ref":"e4"}' } }],
      }, "tool_calls"),
    );
    const chat = new OpenAiChat(new OpenAiApi({ baseUrl: "http://localhost:11434/v1", send: server.send }));
    const response = await chat.send({
      choice: { model: "openai:qwen3:14b", effort: "medium" },
      system: "Work the page.",
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: "Sign up" }] }],
    });

    expect(server.requests[0].body).toMatchObject({
      model: "qwen3:14b",
      messages: [
        { role: "system", content: "Work the page." },
        { role: "user", content: "Sign up" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "click", description: "Click an element", parameters: expect.objectContaining({ required: ["ref"] }) as unknown },
        },
      ],
    });
    expect(response).toEqual({
      content: [
        { type: "text", text: "Clicking." },
        { type: "tool_use", id: "call_1", name: "click", input: { ref: "e4" } },
      ],
      stopReason: "tool_use",
      usage: expect.objectContaining({ calls: 1, costUsd: 0 }) as unknown,
    });
  });

  it("gives tool calls an id when the server doesn't, keeps arguments that don't parse for the tool's check, and maps stops", async () => {
    const server = fakeServer(
      completion(null, { tool_calls: [{ type: "function", function: { name: "click", arguments: "{ref: e4" } }] }, "stop"),
      completion("Done.", {}, "stop"),
      completion("Half", {}, "length"),
    );
    const chat = new OpenAiChat(new OpenAiApi({ baseUrl: "http://x.test/v1", send: server.send }));
    const request = { choice: { model: "openai:m", effort: "low" as const }, system: "s", tools, messages: [] };

    const first = await chat.send(request);
    expect(first.stopReason).toBe("tool_use");
    expect(first.content[0]).toMatchObject({ type: "tool_use", name: "click", input: "{ref: e4", id: expect.stringMatching(/^call_/) as unknown });
    expect((await chat.send(request)).stopReason).toBe("end_turn");
    expect((await chat.send(request)).stopReason).toBe("max_tokens");
  });
});

describe("toOpenAiMessages", () => {
  it("puts tool results right after the calls, images in a user message after them, and leaves out thinking", () => {
    const jpeg = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } };
    expect(
      toOpenAiMessages([
        { role: "user", content: [{ type: "text", text: "Go" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hm", signature: "x" },
            { type: "tool_use", id: "t1", name: "click", input: { ref: "e1" } },
            { type: "tool_use", id: "t2", name: "look", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "No such element", is_error: true },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "The page:" }, jpeg] },
            { type: "text", text: "Two actions left." },
          ],
        },
      ]),
    ).toEqual([
      { role: "user", content: "Go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "click", arguments: '{"ref":"e1"}' } },
          { id: "t2", type: "function", function: { name: "look", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "Error: No such element" },
      { role: "tool", tool_call_id: "t2", content: "The page:" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
          { type: "text", text: "Two actions left." },
        ],
      },
    ]);
  });
});

describe("providers", () => {
  const request = (model: string) => ({ choice: { model, effort: "low" as const }, system: "s", prompt: "p", schema });

  it("routes openai: models to the server and the rest to Claude, and says what is missing", async () => {
    const claude = { structured: jest.fn().mockResolvedValue({ output: "claude" }) };
    const openai = { structured: jest.fn().mockResolvedValue({ output: "openai" }) };
    const both = new RoutedClient(claude, openai);
    expect((await both.structured(request("claude-haiku-5-5"))).output).toBe("claude");
    expect((await both.structured(request("openai:qwen3:14b"))).output).toBe("openai");

    await expect(new RoutedClient(null, openai).structured(request("claude-haiku-5-5"))).rejects.toThrow("ANTHROPIC_API_KEY is not set");
    await expect(new RoutedClient(claude, null).structured(request("openai:qwen3:14b"))).rejects.toThrow(
      "No OpenAI-compatible server is set up (OPENAI_BASE_URL)",
    );
    const chat = new RoutedChat(null, null);
    await expect(chat.send({ choice: { model: "openai:m", effort: "low" }, system: "s", tools: [], messages: [] })).rejects.toThrow("OPENAI_BASE_URL");
  });

  it("is configured with a Claude key or a server", () => {
    expect(llmConfigured({})).toBe(false);
    // A key for OpenAI's embeddings alone doesn't make the default (Claude) models work.
    expect(llmConfigured({ openaiApiKey: KEY })).toBe(false);
    // ...nor sends an openai: model's calls to OpenAI itself: only OPENAI_BASE_URL does.
    expect(openAiApi({ openaiApiKey: KEY })).toBeNull();
    expect(llmConfigured({ anthropicApiKey: KEY })).toBe(true);
    expect(llmConfigured({ openaiBaseUrl: "http://localhost:11434/v1" })).toBe(true);
    expect(llmFromConfig({}).batches).toBeNull();
  });

  it("answers a batch one call after another, without a batch API", async () => {
    let calls = 0;
    const client = {
      structured: jest.fn(() => {
        calls++;
        return calls === 2 ? Promise.reject(new LlmError("bad", { ...emptyUsageFor(), calls: 1 })) : Promise.resolve({ output: { n: calls }, usage: emptyUsageFor() });
      }),
    };
    const batches = new RoutedBatches(null, new SequentialBatches(client as unknown as LlmClient, 1));
    const requests = ["a", "b", "c"].map((customId) => ({ customId, request: request("openai:qwen3:14b") }));
    const id = await batches.submit(requests);
    expect(id).toMatch(/^seq_/);
    while (!(await batches.ended(id))) await new Promise((resolve) => setImmediate(resolve));
    const results = await batches.results(id, schema, "openai:qwen3:14b");
    expect(results.map((r) => [r.customId, r.ok])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
    expect(results[1]).toMatchObject({ error: "bad", usage: { calls: 1 } });
    // Read once; after that (or after a restart) the batch is gone.
    await expect(batches.results(id, schema, "openai:qwen3:14b")).rejects.toThrow("The batch is gone");
    await expect(batches.submit([{ customId: "x", request: request("claude-haiku-5-5") }])).rejects.toThrow("ANTHROPIC_API_KEY");
  });
});

describe("M60 models and cost", () => {
  it("uses LLM_MODEL for every group without its own", () => {
    const router = new ModelRouter(() => Promise.resolve(null), { LLM_MODEL: "openai:qwen3:14b", LLM_MODEL_BUILDER: "claude-opus-5-5" });
    expect(router.fallback("llm.classify")).toMatchObject({ model: "openai:qwen3:14b", effort: "low", source: "env" });
    expect(router.fallback("builder")).toMatchObject({ model: "claude-opus-5-5", source: "env" });
  });

  it("passes over every local model while local models are off, and keeps the tasks' choices for when they are on", async () => {
    const settings: Record<string, { model: string; effort: string }> = {
      "email.classify": { model: "openai:gemma3:12b", effort: "low" },
      "llm.summarize": { model: "claude-opus-5-5", effort: "high" },
    };
    let local = { on: false, model: "openai:qwen3:14b" as string | null };
    const router = new ModelRouter(
      (_userId, task) => Promise.resolve(settings[task] ?? null),
      { LLM_MODEL: "openai:qwen3:8b", LLM_MODEL_BUILDER: "claude-opus-5-5" },
      () => Promise.resolve(local),
    );

    // Off: Claude everywhere (the defaults, a Claude model from .env, a task's Claude choice).
    await expect(router.choose("u", "email.classify")).resolves.toEqual({ model: "claude-haiku-5-5", effort: "low" });
    await expect(router.choose("u", "llm.generate")).resolves.toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    await expect(router.choose("u", "builder")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high" });
    await expect(router.choose("u", "llm.summarize")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high" });

    // On: the task's own choice, else the model for all tasks (over .env), else LLM_MODEL.
    local = { on: true, model: "openai:qwen3:14b" };
    await expect(router.choose("u", "email.classify")).resolves.toEqual({ model: "openai:gemma3:12b", effort: "low" });
    await expect(router.choose("u", "llm.generate")).resolves.toEqual({ model: "openai:qwen3:14b", effort: "medium" });
    await expect(router.choose("u", "builder")).resolves.toEqual({ model: "openai:qwen3:14b", effort: "high" });
    await expect(router.choose("u", "llm.summarize")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(router.fallback("llm.generate", local)).toMatchObject({ source: "local" });

    local = { on: true, model: null };
    await expect(router.choose("u", "llm.generate")).resolves.toEqual({ model: "openai:qwen3:8b", effort: "medium" });
    await expect(router.choose("u", "builder")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high" });
  });

  it("prices a model on an OpenAI-compatible server at nothing, an unknown Claude model at the most", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd("openai:qwen3:14b", tokens)).toBe(0);
    expect(costUsd("claude-unknown", tokens)).toBe(10);
  });
});

function emptyUsageFor() {
  return { models: [], calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}
