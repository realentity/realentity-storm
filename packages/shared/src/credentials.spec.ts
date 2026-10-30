import { CreateCredentialSchema, hostMatches } from "./credentials";

describe("hostMatches", () => {
  it.each([
    ["linkedin.com", ["linkedin.com"], true],
    ["LinkedIn.com.", ["linkedin.com"], true],
    ["www.linkedin.com", ["linkedin.com"], false],
    ["www.linkedin.com", ["*.linkedin.com"], true],
    ["linkedin.com", ["*.linkedin.com"], false],
    ["linkedin.com.evil.net", ["linkedin.com"], false],
    ["evil-linkedin.com", ["*.linkedin.com"], false],
    ["linkedin.com.evil.net", ["*.linkedin.com"], false],
    ["accounts.google.com", ["linkedin.com", "accounts.google.com"], true],
  ])("%s against %j is %s", (host, patterns, expected) => {
    expect(hostMatches(host, patterns)).toBe(expected);
  });
});

describe("CreateCredentialSchema", () => {
  const base = { name: "linkedin", allowedHosts: ["linkedin.com"], kind: "PASSWORD", secret: "x" };

  it("normalizes and dedupes hosts", () => {
    const parsed = CreateCredentialSchema.parse({ ...base, allowedHosts: ["LinkedIn.com", "linkedin.com", " *.linkedin.com "] });
    expect(parsed.allowedHosts).toEqual(["linkedin.com", "*.linkedin.com"]);
  });

  it.each(["https://linkedin.com", "linkedin.com/login", "linkedin.com:443", "*", "*.com.", "a.*.com"])("rejects host %s", (host) => {
    expect(CreateCredentialSchema.safeParse({ ...base, allowedHosts: [host] }).success).toBe(false);
  });

  it("rejects an empty host list and bad names", () => {
    expect(CreateCredentialSchema.safeParse({ ...base, allowedHosts: [] }).success).toBe(false);
    expect(CreateCredentialSchema.safeParse({ ...base, name: "Has Space" }).success).toBe(false);
  });
});
