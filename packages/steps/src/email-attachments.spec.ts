import { defaultCatalog } from "./catalog";

// M59-T1: email.send's attachments, as its gate shows them: an entity's file field, or a list of them.
const input = defaultCatalog().get("email.send")!.input;
const file = (n: number, size = 1000) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `paper-${n}.pdf`, mime: "application/pdf", size });
const mail = { to: "books@accounting.example", subject: "Expenses", body: "Hello" };

describe("email.send's attachments (M59-T1)", () => {
  it("takes one file field or a list of them, lists in it flattened, an entity without one leaving nothing", () => {
    expect(input.parse({ ...mail, attachments: file(1) })).toMatchObject({ attachments: [file(1)] });
    expect(input.parse({ ...mail, attachments: [file(1), [file(2), null], ""] })).toMatchObject({ attachments: [file(1), file(2)] });
    // Nothing to attach: none in the payload (as it is kept, JSON).
    const kept = (value: unknown) => JSON.parse(JSON.stringify(input.parse({ ...mail, attachments: value }))) as Record<string, unknown>;
    expect(kept([null])).toEqual(mail);
    expect(kept(null)).toEqual(mail);
    expect(kept(undefined)).toEqual(mail);
  });

  it("keeps only what a file reference says; refuses what isn't one, too many, or too large together", () => {
    expect(input.parse({ ...mail, attachments: [{ ...file(1), path: "/etc/passwd" }] })).toEqual({ ...mail, attachments: [file(1)] });
    expect(input.safeParse({ ...mail, attachments: ["cv-main"] }).success).toBe(false);
    expect(input.safeParse({ ...mail, attachments: Array.from({ length: 21 }, (_, i) => file(i)) }).success).toBe(false);
    expect(input.safeParse({ ...mail, attachments: [file(1, 10 * 1_048_576), file(2, 9 * 1_048_576)] }).success).toBe(false);
    expect(input.safeParse({ ...mail, attachments: Array.from({ length: 20 }, (_, i) => file(i)) }).success).toBe(true);
  });
});
