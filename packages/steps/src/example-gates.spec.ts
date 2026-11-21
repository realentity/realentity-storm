import { readAppPackage, readAppSource } from "@realentity/storm-shared";
import { exampleFiles } from "@realentity/storm-shared/example-files";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

const catalog = defaultCatalog();
const compiler = new PipelineCompiler(catalog);

/** Each pipeline of an example App, compiled against it: its picks (gate.review) and the side effects that wait at a gate. */
function gatesOf(id: string): Record<string, { review: string[]; act: string[] }> {
  const documents = readAppPackage(exampleFiles()[id]).documents;
  const app = readAppSource(documents[0].source);
  const gates: Record<string, { review: string[]; act: string[] }> = {};
  for (const document of documents.slice(1)) {
    const result = compiler.compileText(document.source, { app });
    if (!result.ok) throw new Error(`${id} / ${document.key}: ${result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    const steps = result.definition.steps;
    const effects = steps.filter((s) => catalog.get(s.type)?.sideEffect).map((s) => s.id);
    const acted = steps.filter((s) => s.type === "gate.act").map((s) => s.with.for as string);
    expect(acted).toEqual(effects);
    gates[String(document.key)] = { review: steps.filter((s) => s.type === "gate.review").map((s) => s.id), act: acted };
  }
  return gates;
}

const none = { review: [], act: [] };

// M58-I1: the Apps M58 added or changed: each compiles against its App, every side effect waits at its gate, and the
// picks are where they should be. A gate lost or moved shows here.
describe("M58's example Apps: their gates", () => {
  it("Papers", () => {
    expect(gatesOf("papers")).toEqual({
      "read-paper": none,
      "warranty-in-calendar": { review: [], act: ["event"] },
      "paper-from-telegram": none,
      "warranty-claim": { review: [], act: ["send"] },
      "contract-cancel": { review: [], act: ["send"] },
      "contract-watch": none,
      "contract-reminder": none,
      "expense-report": { review: ["pick"], act: ["send"] },
    });
  });

  it("Server ops", () => {
    expect(gatesOf("server-ops")).toEqual({
      "check-monitors": none,
      "monitor-alerts": none,
      "database-check": none,
      "database-down": none,
      "incident-issue": { review: [], act: ["issue"] },
      "ops-week": none,
      "fix-offer": { review: [], act: ["fix"] },
      fix: { review: [], act: ["fix"] },
    });
  });

  it("Follow-ups, Meetings and Quotes", () => {
    expect(gatesOf("follow-ups")).toEqual({ "follow-ups": { review: [], act: ["send"] }, snooze: none, wake: none });
    expect(gatesOf("meetings")).toEqual({ meetings: { review: [], act: ["send", "event"] }, "meeting-nudge": { review: [], act: ["send"] } });
    expect(gatesOf("quotes")).toEqual({
      "quote-ask": { review: [], act: ["send"] },
      "quote-read": none,
      "quote-accept": { review: [], act: ["accept", "decline"] },
    });
  });

  it("Hiring and Tenders: a shortlist picked first", () => {
    expect(gatesOf("hiring")).toEqual({ applications: { review: ["shortlist"], act: ["invite", "decline"] } });
    expect(gatesOf("tenders")).toEqual({ tenders: { review: ["shortlist"], act: ["apply"] } });
  });

  it("Announcements and Newsletter", () => {
    expect(gatesOf("announcements")).toEqual({ announce: { review: [], act: ["post"] } });
    expect(gatesOf("newsletter")).toEqual({ "collect-links": none, "newsletter-issue": { review: ["pick"], act: ["send"] } });
  });
});
