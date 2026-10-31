import { defaultCatalog } from "./catalog";
import { describeCatalog } from "./describe";

describe("describeCatalog", () => {
  const text = describeCatalog(defaultCatalog());

  it("lists every catalog step, and only those", () => {
    const listed = [...text.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
    expect(listed).toEqual(
      defaultCatalog()
        .list()
        .map((s) => s.type),
    );
  });

  it("gives each parameter's type, bounds, default and whether it may be left out", () => {
    expect(text).toContain("## email.fetch");
    expect(text).toContain('  mailbox?: string (1–200 chars) = "INBOX"');
    expect(text).toContain("  limit?: integer (1–200) = 50");
    expect(text).toContain('  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in"');
    expect(text).toContain("  to: string (email)");
    expect(text).toContain("  messages: list of EmailMessage");
    expect(text).toMatch(/^EmailMessage:\n {2}uid: integer$/m);
    expect(text).not.toContain("9007199254740991");
  });

  it("flags side effects and their targets, and LLM-written output", () => {
    expect(text).toMatch(/## email\.send\n.*\nFlags: SIDE EFFECT .*; targets: to \(recipient\)/);
    expect(text).toMatch(/## email\.draftReply\n.*\nFlags: output written by an LLM/);
  });
});
