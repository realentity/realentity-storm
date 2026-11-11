import {
  factsThatFit,
  isTextFile,
  looksSecret,
  matchWords,
  MEMORY_TEXT,
  memoryLine,
  normalizeDirection,
  pathMatches,
  TopicFactSchema,
  TopicSourceSchema,
  driveFolderId,
} from "./topics-api";

// M42-S1 (part): a topic's fact never holds a secret
describe("looksSecret", () => {
  it.each([
    "The staging password: Orion-2026!",
    "the API key is 4f9a8c2e",
    "Token = abc",
    "парола: зима2026",
    "Passwort: Sommer",
    "-----BEGIN RSA PRIVATE KEY-----",
    "use ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
    "AKIAIOSFODNN7EXAMPLE",
    "key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ])("%s: a secret", (text) => {
    expect(looksSecret(text)).toBe(true);
  });

  it.each([
    "Launch: March 2027",
    "The token budget is tight",
    "Secret Santa on 18 December",
    "The PIN pad arrives Monday",
    "Maria owns the API spec",
    "Docs: https://docs.client.example/orion/architecture/decisions/0012-use-postgresql",
    "Budget: 2 000 000 EUR",
  ])("%s: not a secret", (text) => {
    expect(looksSecret(text)).toBe(false);
  });

  it("a fact that looks like one is refused without repeating it", () => {
    const result = TopicFactSchema.safeParse({ about: "Staging", statement: "password: hunter2" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("hunter2");
  });
});

// M43-T1: a source's path pattern
describe("pathMatches", () => {
  it.each([
    ["docs/adr/**", "docs/adr/0012-use-postgresql.md", true],
    ["docs/adr/**", "docs/adr/old/0001.md", true],
    ["docs/adr/**", "docs/other/0001.md", false],
    ["docs/adr", "docs/adr/0001.md", true],
    ["docs/adr", "docs/adrs/0001.md", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/spec/api.md", true],
    ["**/*.md", "docs/spec/api.txt", false],
    ["docs/*.md", "docs/a/b.md", false],
    ["docs/{adr,spec}/**", "docs/spec/api.md", true],
    ["docs/{adr,spec}/**", "docs/notes/x.md", false],
    ["**", "anything/at/all.md", true],
    ["docs/0?.md", "docs/01.md", true],
  ])("%s, %s: %s", (pattern, path, expected) => {
    expect(pathMatches(pattern, path)).toBe(expected);
  });

  it("a source: a repository from its address, the path cleaned, nothing outside the repository", () => {
    expect(TopicSourceSchema.parse({ kind: "GITHUB", location: "https://github.com/acme/orion.git", path: "/docs/adr/**" })).toEqual({
      kind: "GITHUB",
      location: "acme/orion",
      path: "docs/adr/**",
    });
    expect(TopicSourceSchema.safeParse({ kind: "GITHUB", location: "acme" }).success).toBe(false);
    expect(TopicSourceSchema.safeParse({ kind: "GITHUB", location: "acme/orion", path: "../secrets/**" }).success).toBe(false);
    expect(isTextFile("docs/adr/0012.md")).toBe(true);
    expect(isTextFile("docs/diagram.png")).toBe(false);
  });

  it("a Drive source: a folder from its link or id, without a branch or a credential", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUv-_x";
    for (const pasted of [
      `https://drive.google.com/drive/folders/${id}`,
      `https://drive.google.com/drive/u/0/folders/${id}?usp=sharing`,
      `https://drive.google.com/open?id=${id}`,
      ` ${id} `,
    ]) {
      expect(driveFolderId(pasted)).toBe(id);
    }
    expect(driveFolderId("https://drive.google.com/file/d/abc")).toBeNull();
    expect(driveFolderId("not a folder")).toBeNull();
    expect(
      TopicSourceSchema.parse({ kind: "DRIVE", location: `https://drive.google.com/drive/folders/${id}`, branch: "main", credential: "x" }),
    ).toEqual({
      kind: "DRIVE",
      location: id,
      path: "**",
      branch: null,
      credential: null,
    });
    expect(TopicSourceSchema.safeParse({ kind: "DRIVE", location: "acme/orion" }).success).toBe(false);
  });
});

// M44-T7
describe("a draft's room for facts", () => {
  const fact = (about: string, statement: string) => ({
    about,
    statement,
    source: "EMAIL",
    sourceLabel: "maria@client.example: Plan",
    sourceDate: "2026-11-12T09:00:00.000Z",
  });

  it("a fact's line: who said it and when, the user's own as the user's", () => {
    expect(memoryLine(fact("Launch date", "March"))).toBe("Launch date: March (maria@client.example: Plan, 2026-11-12)");
    expect(memoryLine({ ...fact("Launch date", "March"), source: "USER", sourceDate: new Date("2026-11-12T09:00:00Z") })).toBe(
      "Launch date: March (the user, 2026-11-12)",
    );
  });

  it("all fit, or as many as the room holds after the description", () => {
    expect(factsThatFit("The portal", [fact("Launch date", "March")])).toBe(1);
    const long = Array.from({ length: 20 }, (_, i) => fact(`Item ${i}`, "x".repeat(500)));
    const fit = factsThatFit("", long);
    expect(fit).toBeGreaterThan(5);
    expect(fit).toBeLessThan(20);
    expect(factsThatFit("d".repeat(MEMORY_TEXT), long)).toBeLessThan(fit);
  });

  it("words: four letters or digits or more, any language, lowercase", () => {
    expect([...matchWords("The API launch: März 2027, in Sofia — Пловдив too")]).toEqual(["launch", "märz", "2027", "sofia", "пловдив"]);
  });
});

// CodeQL: no slow regular expression on what a user or a source sends
describe("odd input is answered quickly", () => {
  it("an address: the same answers, and a long run of '!.' after '@' rejected at once", () => {
    const person = (value: string) => normalizeDirection({ kind: "PERSON", value });
    expect(person("ivan@client.example")).toMatchObject({ kind: "PERSON", value: "ivan@client.example" });
    expect(person("ivan@mail.client.example")).toMatchObject({ value: "ivan@mail.client.example" });
    expect(person("ivan@client")).toEqual({ error: "Not an email address" });
    expect(person("ivan@client..example")).toEqual({ error: "Not an email address" });
    const start = Date.now();
    expect(person(`!@!.${"!.".repeat(5_000)}`)).toEqual({ error: "Not an email address" });
    // Longer than an address can be.
    expect(person(`a@b${".c".repeat(130)}`)).toEqual({ error: "Not an email address" });
    // Linear takes a few ms; quadratic would take seconds. The margin is for a busy CI runner.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("a pattern: trailing slashes trimmed by a loop, also thousands of them", () => {
    expect(pathMatches("docs/adr///", "docs/adr/0001.md")).toBe(true);
    const start = Date.now();
    expect(pathMatches(`docs${"/".repeat(20_000)}x`, "docs/x.md")).toBe(false);
    // Linear takes a few ms; quadratic would take seconds. The margin is for a busy CI runner.
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
