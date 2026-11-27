import { parse } from "yaml";

/**
 * The builder's model in the browser tests (the shape of @realentity/storm-llm's LlmChat): nothing goes to Claude. Asked to
 * "also include <place>", it adds the place to the search query of the pipeline it was shown and proposes that;
 * after a tool result it answers in one sentence; "a new idea: …" gets a brief back (M70-T2); anything else gets a
 * question back. An editor's draft (M38-T5) wins
 * over the saved version.
 */
export const TEST_BUILDER_LLM = {
  send(request: { messages: { role: string; content: { type: string; [key: string]: unknown }[] }[] }) {
    const usage = {
      models: ["claude-opus-5-5"],
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
    };
    const last = request.messages.at(-1)?.content ?? [];
    if (last.some((b) => b.type === "tool_result")) {
      const failed = last.some((b) => b.type === "tool_result" && b.is_error);
      const briefed = last.some((b) => b.type === "tool_result" && String(b.content).startsWith("Shown to the user as the brief"));
      let text = "The search now includes it.";
      if (failed) text = "That didn't compile.";
      else if (briefed) text = "That's what I'd build: agreed?";
      return Promise.resolve({
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage,
      });
    }

    // The pipeline as last shown to the builder, and what the test asked.
    const texts = request.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => String(b.text)));
    const shown = texts
      .map(
        (t) =>
          /<editor_draft>\n([\s\S]*?)<\/editor_draft>/.exec(t)?.[1] ??
          /<current_pipeline[^>]*>\n([\s\S]*?)<\/current_pipeline>/.exec(t)?.[1],
      )
      .filter(Boolean)
      .at(-1);
    // M70-T2: a new idea is said back as a brief first.
    if (/a new idea:/i.test(texts.at(-1) ?? "")) {
      const brief = {
        summary: "Watches the prices of the products you choose and tells you when one gets cheaper.",
        app: { name: "Prices", types: [{ name: "Product", about: "a product you watch, by its page", fields: ["its page (you type it)", "the price"] }] },
        pipelines: [{ name: "Watch", trigger: "every day at 8:00", does: "reads each product's price", sends: "a Telegram message to you" }],
        setup: ["Telegram"],
        cannot: ["buying for you"],
      };
      return Promise.resolve({ content: [{ type: "tool_use", id: "toolu_brief", name: "state_brief", input: brief }], stopReason: "tool_use", usage });
    }
    const place = /also include (\w+)/i.exec(texts.at(-1) ?? "")?.[1];
    if (!shown || !place) {
      return Promise.resolve({ content: [{ type: "text", text: "Which place should I add?" }], stopReason: "end_turn", usage });
    }
    const pipeline = parse(shown) as { steps: { id: string; with: Record<string, unknown> }[] };
    const search = pipeline.steps.find((s) => s.id === "search");
    if (search) search.with.query = `${String(search.with.query)} ${place}`;
    return Promise.resolve({
      content: [{ type: "tool_use", id: "toolu_e2e", name: "propose_pipeline", input: { summary: `Also search in ${place}`, pipeline } }],
      stopReason: "tool_use",
      usage,
    });
  },
};
