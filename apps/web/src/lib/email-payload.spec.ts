import { describe, expect, it } from "vitest";
import { emailFields, threadLength } from "./email-payload";

describe("emailFields", () => {
  it("puts To and Subject first and the message after them, whatever order the payload has", () => {
    const fields = emailFields({
      body: "Hi",
      to: "maria@client.example",
      references: ["<a@x.test>"],
      subject: "Re: Plan",
      inReplyTo: "<b@x.test>",
    });
    expect(fields).toEqual({ headers: ["to", "subject"], body: "body", thread: ["inReplyTo", "references"], other: [] });
  });

  it("leaves out empty threading, and keeps fields it doesn't know", () => {
    const fields = emailFields({ to: "a@x.test", subject: "Hello", body: "Hi", references: [], inReplyTo: "", attachments: ["cv"] });
    expect(fields.thread).toEqual([]);
    expect(fields.other).toEqual(["attachments"]);
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
