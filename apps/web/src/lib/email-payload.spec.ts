import { describe, expect, it } from "vitest";
import { emailFields, fileSize, threadLength } from "./email-payload";

describe("emailFields", () => {
  it("puts To and Subject first and the message after them, whatever order the payload has", () => {
    const fields = emailFields({
      body: "Hi",
      to: "maria@client.example",
      references: ["<a@x.test>"],
      subject: "Re: Plan",
      inReplyTo: "<b@x.test>",
    });
    expect(fields).toEqual({ headers: ["to", "subject"], body: "body", attachments: [], thread: ["inReplyTo", "references"], other: [] });
  });

  it("leaves out empty threading, and keeps fields it doesn't know", () => {
    const fields = emailFields({ to: "a@x.test", subject: "Hello", body: "Hi", references: [], inReplyTo: "", tracking: ["cv"] });
    expect(fields.thread).toEqual([]);
    expect(fields.other).toEqual(["tracking"]);
  });

  it("lists an App's files it attaches by name and size (M59-T1)", () => {
    const fields = emailFields({ to: "a@x.test", attachments: [{ id: "f1", name: "receipt.pdf", mime: "application/pdf", size: 20480 }] });
    expect(fields.attachments).toEqual([{ name: "receipt.pdf", mime: "application/pdf", size: 20480 }]);
    expect(fields.other).toEqual([]);
    expect(fileSize(20480)).toBe("20 KB");
    expect(fileSize(2_400_000)).toBe("2.3 MB");
  });

  it("has no message when the payload has none", () => {
    expect(emailFields({ to: "a@x.test" }).body).toBeNull();
  });
});

describe("threadLength", () => {
  it("counts the earlier messages once, In-Reply-To being one of the References", () => {
    expect(threadLength({ inReplyTo: "<b@x.test>", references: ["<a@x.test>", "<b@x.test>"] })).toBe(2);
    expect(threadLength({ to: "a@x.test" })).toBe(0);
  });
});
