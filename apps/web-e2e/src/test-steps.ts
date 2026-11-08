import { type StepDefinition } from "@realentity/storm-steps";
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
 * steps that would reach a real site: browser.fillAndSubmit and browser.submit answer with what they were asked to send,
 * http.fetch with two made-up releases.
 */
export const TEST_EXECUTORS = [
  // M40-E1: the starter example reads public release feeds; here, two releases of the first feed, whatever it asks.
  {
    type: "http.fetch",
    execute: (input: Record<string, unknown>) => {
      const source = String((input.urls as string[] | undefined)?.[0] ?? input.url);
      const items = [1, 2].map((n) => ({
        id: `${source}#v${n}.0.0`,
        title: `v${n}.0.0`,
        url: `${source.replace(/\.atom$/, "")}/tag/v${n}.0.0`,
        published: `2026-11-0${n}T09:00:00Z`,
        summary: `Release ${n}`,
        source,
      }));
      return Promise.resolve({ items, json: null, text: "", documents: [] });
    },
  },
  {
    type: "browser.fillAndSubmit",
    execute: (input: Record<string, unknown>) =>
      Promise.resolve({ submitted: true, url: String(input.url), confirmation: JSON.stringify({ fields: input.fields, files: input.files }) }),
  },
  {
    type: "browser.submit",
    execute: (input: Record<string, unknown>) =>
      Promise.resolve({ submitted: true, url: String(input.url), confirmation: JSON.stringify({ actions: input.actions, files: input.files }) }),
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
