import { isNoReplyAddress, unanswerable } from "./email-addresses";

describe("who can't be answered", () => {
  it("no-reply addresses, and not the ones that only look alike", () => {
    for (const address of [
      "noreply@github.com",
      "no-reply@accounts.google.com",
      "messaging-digest-noreply@linkedin.com",
      "billing-noreply@senetic.com",
      "account-security-noreply@accountprotection.microsoft.com",
      "no-reply-a1b2c3d4e5f6g7h8i-xyzq@mail.anthropic.com",
      "do-not-reply@bank.test",
      "DoNotReply@service.test",
      "no_reply@x.test",
      "MAILER-DAEMON@mail.test",
      "bounces+123@mail.test",
    ])
      expect([address, isNoReplyAddress(address)]).toEqual([address, true]);
    for (const address of ["ana@acme.test", "reply@acme.test", "nora.eply@acme.test", "talent@tide.co", "info@noreplyacme.test"])
      expect([address, isNoReplyAddress(address)]).toEqual([address, false]);
  });

  it("a no-reply sender, or the user's own to themselves", () => {
    expect(unanswerable({ from: "ana@acme.test", to: ["me@storm.test"] })).toBeNull();
    expect(unanswerable({ from: "noreply@acme.test", to: ["me@storm.test"] })).toBe("noreply@acme.test is a no-reply address");
    expect(unanswerable({ from: "Me@Storm.test", to: ["me@storm.test"] })).toBe("it was sent to its own sender");
    expect(unanswerable({ from: "", to: ["me@storm.test"] })).toBe("it has no sender");
  });
});
