import { BuilderBriefSchema } from "@realentity/storm-shared";
import { briefText } from "./telegram-builder";

// M70-T2: on Telegram the brief is lines, as the Builder page's card says it
describe("briefText", () => {
  it("says the App and its types, each pipeline, what I set up and what Storm can't do", () => {
    const brief = BuilderBriefSchema.parse({
      summary: "Keeps my bills from email.",
      app: { name: "Bills", types: [{ name: "Bill", about: "one bill, by its sender and reference; due, then paid", fields: ["amount", "due date"] }, { name: "Note", about: "mine", fields: [] }] },
      pipelines: [{ name: "Read bills", trigger: "every day at 8:00", does: "reads my email and saves the bills" }],
      setup: ["an email account", "Telegram"],
      cannot: ["pay a bill"],
    });
    expect(briefText(brief).split("\n")).toEqual([
      "What I'll make: Keeps my bills from email.",
      "App: Bills",
      "• Bill: one bill, by its sender and reference; due, then paid (amount, due date)",
      "• Note: mine",
      "Pipeline Read bills, every day at 8:00: reads my email and saves the bills",
      "You set up: an email account; Telegram",
      "Storm can't: pay a bill",
    ]);
  });
});
