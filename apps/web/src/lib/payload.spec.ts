import { type TargetView } from "@realentity/storm-shared";
import { describe, expect, it } from "vitest";
import { formatDuration, formatUsd, statusLabel, statusTone } from "./format";
import { changedFields, editableText, newTargets, readEdits } from "./payload";

describe("payload editing", () => {
  const original = { to: "ana@acme.test", body: "Thanks", cc: ["x@acme.test"], meta: { a: 1 } };

  it("reads edited fields back: strings as text, others as JSON; reports fields that don't parse", () => {
    const texts = Object.fromEntries(Object.entries(original).map(([k, v]) => [k, editableText(v)]));
    expect(readEdits(original, texts)).toEqual({ ok: true, payload: original });

    expect(readEdits(original, { ...texts, body: "Thanks a lot", meta: '{"a": 2}' })).toEqual({
      ok: true,
      payload: { ...original, body: "Thanks a lot", meta: { a: 2 } },
    });
    expect(readEdits(original, { ...texts, cc: "[not json" })).toEqual({ ok: false, invalid: ["cc"] });
  });

  it("lists the changed top-level fields, as the decision records them", () => {
    expect(changedFields(original, { ...original, meta: { a: 1 } })).toEqual([]);
    expect(changedFields(original, { ...original, body: "Hi", cc: [] })).toEqual(["body", "cc"]);
  });

  it("flags targets an edit introduces, normalized like the worker (hosts for domains)", () => {
    const targets: TargetView[] = [
      { field: "to", kind: "recipient", value: "ana@acme.test", basis: "provenance", isNew: true },
      { field: "url", kind: "domain", value: "jobs.example.org", basis: "static", isNew: false },
    ];
    const edited = { to: "Bob@Other.test", url: "https://jobs.example.org/apply/2", body: "x" };
    expect(newTargets(targets, edited)).toEqual(["bob@other.test"]);
    expect(newTargets(targets, { ...edited, to: "ana@acme.test", url: "https://evil.example/x" })).toEqual(["evil.example"]);
  });
});

describe("format", () => {
  it("money, durations and statuses", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0014)).toBe("$0.0014");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatDuration("2026-10-31T08:00:00Z", "2026-10-31T08:00:01.250Z")).toBe("1.3 s");
    expect(formatDuration("2026-10-31T08:00:00Z", "2026-10-31T08:03:05Z")).toBe("3 min 5 s");
    expect(formatDuration("2026-10-31T08:00:00Z", null)).toBe("");
    expect(statusLabel("WAITING_FOR_USER")).toBe("waiting for me");
    expect(statusTone("FAILED")).toBe("red");
    expect(statusTone("SOMETHING_NEW")).toBe("secondary");
  });
});
