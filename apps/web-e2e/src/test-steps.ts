import { type StepDefinition } from "@ai-me/steps";
import { z } from "zod";

/**
 * Steps only the browser tests have. The catalog's first real side-effect step (email.send) arrives in M4, and these
 * stand in for it: the api compiles against them, the worker runs them. Nothing leaves the machine.
 */
export const RECRUITERS = [
  { title: "Senior .NET", recruiter: "ana@acme.test" },
  { title: "Lead .NET", recruiter: "bob@other.test" },
];

export const TEST_STEPS: StepDefinition[] = [
  {
    type: "test.search",
    description: "Finds two job posts (test data).",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ query: z.string() }),
    output: z.object({ items: z.array(z.object({ title: z.string(), recruiter: z.string(), query: z.string() })) }),
  },
  {
    type: "test.send",
    description: "Sends a message (test: records it, sends nothing).",
    sideEffect: true,
    saasSafe: true,
    targets: { to: "recipient" },
    input: z.object({ to: z.string(), body: z.string() }),
    output: z.object({ sentTo: z.string(), sentBody: z.string() }),
  },
  {
    type: "test.wait",
    description: "Waits a while (test: a slow step).",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ ms: z.number().int().min(0).max(30_000) }),
    output: z.object({ waited: z.number() }),
  },
];

/**
 * The worker side: implementations of TEST_STEPS (the shape of the worker's StepExecutor), and stand-ins for catalog
 * steps that would reach a real site: browser.fillAndSubmit answers with what it was asked to send.
 */
export const TEST_EXECUTORS = [
  {
    type: "browser.fillAndSubmit",
    execute: (input: Record<string, unknown>) =>
      Promise.resolve({ submitted: true, url: String(input.url), confirmation: JSON.stringify({ fields: input.fields, files: input.files }) }),
  },
  {
    type: "test.search",
    execute: (input: Record<string, unknown>) => Promise.resolve({ items: RECRUITERS.map((r) => ({ ...r, query: String(input.query) })) }),
  },
  {
    type: "test.send",
    execute: (input: Record<string, unknown>) => Promise.resolve({ sentTo: String(input.to), sentBody: String(input.body) }),
  },
  {
    type: "test.wait",
    execute: async (input: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, Number(input.ms)));
      return { waited: Number(input.ms) };
    },
  },
];
