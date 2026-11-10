import { looksSecret, TopicFactSchema } from "./topics-api";

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
