import { hasWord, matchDirections, type MatchableEmail } from "./topic-match";
import { normalizeDirection } from "./topics-api";

const email = (extra: Partial<MatchableEmail> = {}): MatchableEmail => ({
  from: "ana@acme.test",
  to: ["me@storm.test"],
  cc: [],
  subject: "Hello",
  text: "Hi there.",
  ...extra,
});

// M41-U1
describe("topic directions without an LLM", () => {
  it("a word: whole, any case, in the subject or the text, any script", () => {
    const orion = [{ kind: "WORD" as const, value: "Orion", about: null }];
    expect(matchDirections(email({ subject: "Re: ORION kickoff" }), orion).exact).toBe('the word "Orion"');
    expect(matchDirections(email({ text: "About orion's API." }), orion).exact).toBe('the word "Orion"');
    expect(matchDirections(email({ text: "Orionids tonight" }), orion).exact).toBeNull();
    expect(matchDirections(email({ text: "Project-Orion2" }), orion).exact).toBeNull();
    expect(hasWord("Проект Скайлайт стартира", "скайлайт")).toBe(true);
    expect(hasWord("Payment  integration", "payment integration")).toBe(true);
    expect(hasWord("a+b=c", "a+b")).toBe(true);
  });

  it("a domain: anyone on the email from it or its subdomains, not a lookalike", () => {
    const client = [{ kind: "DOMAIN" as const, value: "client.example", about: null }];
    expect(matchDirections(email({ from: "ivan@client.example" }), client).exact).toBe("ivan@client.example, at client.example");
    expect(matchDirections(email({ cc: ["Maria@EU.Client.example"] }), client).exact).toBe("maria@eu.client.example, at client.example");
    expect(matchDirections(email({ from: "x@otherclient.example" }), client).exact).toBeNull();
    expect(matchDirections(email({ from: "x@client.example.evil.test" }), client).exact).toBeNull();
  });

  it("a person: on the email; about something, only a hint for the LLM", () => {
    expect(
      matchDirections(email({ to: ["ivan@client.example"] }), [{ kind: "PERSON", value: "ivan@client.example", about: null }]).exact,
    ).toBe("ivan@client.example takes part");
    const about = matchDirections(email({ from: "ivan@client.example" }), [
      { kind: "PERSON", value: "ivan@client.example", about: "the API" },
    ]);
    expect(about).toEqual({ exact: null, hints: ["ivan@client.example takes part: does it belong when it is about the API?"] });
    expect(matchDirections(email(), [{ kind: "PERSON", value: "ivan@client.example", about: "the API" }]).hints).toEqual([]);
  });

  it("plain words are the LLM's to judge", () => {
    expect(
      matchDirections(email({ text: "the payment integration" }), [{ kind: "TEXT", value: "the payment integration", about: null }]),
    ).toEqual({
      exact: null,
      hints: [],
    });
  });

  it("directions are stored normalized", () => {
    expect(normalizeDirection({ kind: "DOMAIN", value: " *.Client.Example " })).toEqual({
      kind: "DOMAIN",
      value: "client.example",
      about: null,
    });
    expect(normalizeDirection({ kind: "PERSON", value: "Ivan@Client.Example", about: "  " })).toEqual({
      kind: "PERSON",
      value: "ivan@client.example",
      about: null,
    });
    expect(normalizeDirection({ kind: "TEXT", value: "ok", about: null })).toEqual({ error: "Plain words of 3 to 500 characters" });
    expect(normalizeDirection({ kind: "DOMAIN", value: "client.example", about: "x" })).toEqual({
      error: "Only a person's direction says what about",
    });
  });
});
