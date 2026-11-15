import { z } from "zod";
import { inputError } from "./input-errors";

const fetchInput = z.object({
  url: z.string().url(),
  query: z.record(z.string(), z.string()).optional(),
  count: z.number().int().optional(),
});
const errorOf = (value: unknown) => {
  const parsed = fetchInput.safeParse(value);
  if (parsed.success) throw new Error("expected it not to fit");
  return parsed.error;
};

describe("inputError", () => {
  it("names each field by its path, and the reference it was written as", () => {
    const written = { url: "https://example.com/search", query: { name: "{{trigger.data.trip.destination}}" } };
    expect(inputError(errorOf({ url: "https://example.com/search", query: { name: undefined } }), written)).toBe(
      "query.name expected string, received undefined (from {{trigger.data.trip.destination}})",
    );
  });

  it("leaves out a reference when the value was written as it is, and joins several fields", () => {
    expect(inputError(errorOf({ url: "not a link", count: "3" }), { url: "not a link", count: "3" })).toMatch(
      /^url .+; count expected number, received string$/,
    );
  });

  it("passes any other error's message through", () => {
    expect(inputError(new Error("Unknown step"), {})).toBe("Unknown step");
    expect(inputError("plain", {})).toBe("plain");
  });
});
