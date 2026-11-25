import { z } from "zod";
import { LlmError } from "./claude-client";
import { ModelRouter } from "./models";
import { OpenAiApi, OpenAiChat, OpenAiClient, parseServerModel, serverModelId, toOpenAiMessages } from "./openai";
import { SequentialBatches, llmFromConfig, llmOver } from "./providers";
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
  const SERVER = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const request = (model: string, owner?: string) => ({ choice: { model, effort: "low" as const, owner }, system: "s", prompt: "p", schema });

  // M62: the server and the Claude key are looked up at each call, in the settings of whom the model was chosen for
  it("finds a model's server by the id in its name, for its owner, and says where to set up what is missing", async () => {
    const server = fakeServer(completion('{"category":"other","amount":null}'));
    const where = {
      claude: jest.fn(() => Promise.resolve(null)),
      server: jest.fn((id: string | null) => Promise.resolve(id === SERVER ? { baseUrl: "http://ollama.test/v1", send: server.send } : null)),
    };
    const llm = llmOver(where);

    const answer = await llm.client.structured(request(`openai:${SERVER}:qwen3:14b`, "user-1"));
    expect(answer.output).toEqual({ category: "other", amount: null });
    expect(where.server).toHaveBeenCalledWith(SERVER, "user-1");
    expect(server.requests[0]).toMatchObject({ url: "http://ollama.test/v1/chat/completions", body: { model: "qwen3:14b" } });

    await expect(llm.client.structured(request("claude-haiku-5-5", "user-1"))).rejects.toThrow("Claude isn't set up or is off (Settings → AI → Model servers)");
    expect(where.claude).toHaveBeenCalledWith("user-1");
    await expect(llm.client.structured(request("openai:5a1b2c3d-0000-4a6b-8c7d-9e0f1a2b3c4d:m"))).rejects.toThrow("This model's server isn't set up or is off");
    await expect(llm.chat.send({ choice: { model: "claude-opus-5-5", effort: "low" }, system: "s", tools: [], messages: [] })).rejects.toThrow("Claude isn't set up");
  });

  it("reads a model's server and name out of its id; one without a server id is a fixed setup's", () => {
    expect(parseServerModel(`openai:${SERVER.toUpperCase()}:hf.co/org/model:Q4_K_M`)).toEqual({ serverId: SERVER, name: "hf.co/org/model:Q4_K_M" });
    expect(parseServerModel("openai:qwen3:14b")).toEqual({ serverId: null, name: "qwen3:14b" });
    expect(serverModelId(SERVER, "qwen3:14b")).toBe(`openai:${SERVER}:qwen3:14b`);
  });

  it("answers a batch one call after another, without a batch API, and finds it again by its id", async () => {
    const server = fakeServer(completion('{"category":"bill","amount":1}'), new Error("down"), completion('{"category":"bill","amount":3}'));
    const batches = llmFromConfig({ openaiBaseUrl: "http://ollama.test/v1" }).batches;
    // The fixed setup's server has no fake fetch: a SequentialBatches of its own shows the order instead.
    const direct = new SequentialBatches(new OpenAiClient(new OpenAiApi({ baseUrl: "http://ollama.test/v1", send: server.send })), 1);
    const id = await direct.submit(["a", "b", "c"].map((customId) => ({ customId, request: request("openai:qwen3:14b") })));
    expect(id).toMatch(/^seq_/);
    while (!(await direct.ended(id))) await new Promise((resolve) => setImmediate(resolve));
    const results = await direct.results(id);
    expect(results.map((r) => [r.customId, r.ok])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
    // Read once; after that (or after a restart) the batch is gone.
    await expect(direct.results(id)).rejects.toThrow("The batch is gone");
    await expect(batches.ended("seq_unknown")).rejects.toThrow("The batch is gone");
    await expect(batches.submit([{ customId: "x", request: request("claude-haiku-5-5") }])).rejects.toThrow("Claude isn't set up");
  });

  it("keeps a Claude batch's owner in its id, so its key is found again when it is polled", async () => {
    const claude = jest.fn(() => Promise.resolve(null));
    const { batches } = llmOver({ claude, server: () => Promise.resolve(null) });
    await expect(batches.ended("claude:user-7:msgbatch_123")).rejects.toThrow("Claude isn't set up");
    expect(claude).toHaveBeenCalledWith("user-7");
  });
});

describe("M62 model choice", () => {
  const SERVER = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const local = `openai:${SERVER}:qwen3:14b`;

  it("a task's own choice, else the default model, else the built-in one; a model that can't be used now is passed over", async () => {
    const settings: Record<string, { model: string; effort: string }> = {
      "email.classify": { model: `openai:${SERVER}:gemma3:12b`, effort: "low" },
      "llm.summarize": { model: "claude-opus-5-5", effort: "high" },
    };
    let on = false;
    const router = new ModelRouter(
      (_userId, task) => Promise.resolve(settings[task] ?? null),
      () => Promise.resolve({ defaultModel: local, usable: (model: string) => on || !model.startsWith("openai:") }),
    );

    // The server off: its models are passed over, the choices kept.
    await expect(router.choose("u", "email.classify")).resolves.toEqual({ model: "claude-haiku-5-5", effort: "low", owner: "u" });
    await expect(router.choose("u", "llm.generate")).resolves.toEqual({ model: "claude-sonnet-5-5", effort: "medium", owner: "u" });
    await expect(router.choose("u", "llm.summarize")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high", owner: "u" });
    expect(router.fallback("llm.generate")).toEqual({ model: "claude-sonnet-5-5", effort: "medium", source: "built-in" });

    on = true;
    await expect(router.choose("u", "email.classify")).resolves.toEqual({ model: `openai:${SERVER}:gemma3:12b`, effort: "low", owner: "u" });
    await expect(router.choose("u", "builder")).resolves.toEqual({ model: local, effort: "high", owner: "u" });
    await expect(router.choose("u", "llm.summarize")).resolves.toEqual({ model: "claude-opus-5-5", effort: "high", owner: "u" });
    expect(router.fallback("builder", { defaultModel: local, usable: () => true })).toEqual({ model: local, effort: "high", source: "default" });
  });

  it("prices a model on an OpenAI-compatible server at nothing, an unknown Claude model at the most", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd(local, tokens)).toBe(0);
    expect(costUsd("openai:qwen3:14b", tokens)).toBe(0);
    expect(costUsd("claude-unknown", tokens)).toBe(10);
  });
});
