import { PASSAGE_TEXT, passagesOf } from "./chunk";

// M43-T3: a file's passages
describe("passagesOf", () => {
  it("splits at headings, each passage under its headings; code blocks aren't headings", () => {
    const adr = [
      "# ADR-0012: Use PostgreSQL",
      "",
      "Status: accepted",
      "",
      "## Context",
      "We need one database for the portal.",
      "",
      "## Decision",
      "",
      "PostgreSQL 17, managed.",
      "",
      "```bash",
      "# not a heading",
      "psql",
      "```",
      "",
      "### Backups",
      "Nightly.",
      "* kept for 30 days",
    ].join("\n");
    expect(passagesOf(adr)).toEqual([
      { heading: "ADR-0012: Use PostgreSQL", text: "Status: accepted" },
      { heading: "ADR-0012: Use PostgreSQL > Context", text: "We need one database for the portal." },
      { heading: "ADR-0012: Use PostgreSQL > Decision", text: "PostgreSQL 17, managed.\n\n```bash\n# not a heading\npsql\n```" },
      { heading: "ADR-0012: Use PostgreSQL > Decision > Backups", text: "Nightly.\n* kept for 30 days" },
    ]);
  });

  it("long sections in pieces of at most a passage, cut at sentence ends; the same text, the same passages", () => {
    const sentence = "The portal keeps every order for seven years. ";
    const text = `# Retention\n\n${sentence.repeat(80)}\n\n${"Short paragraph.\n\n".repeat(3)}`;
    const passages = passagesOf(text);
    expect(passages.length).toBeGreaterThan(2);
    expect(passages.every((p) => p.text.length <= PASSAGE_TEXT && p.heading === "Retention")).toBe(true);
    expect(passages[0]?.text.endsWith(".")).toBe(true);
    expect(passagesOf(text)).toEqual(passages);
    expect(passagesOf("")).toEqual([]);
  });
});
