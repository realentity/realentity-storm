import { proposalMessage, type ProposalForTelegram } from "./telegram-proposals";

const EMAIL: ProposalForTelegram = {
  proposalId: "00000000-0000-4000-8000-000000000001",
  pipeline: "Replies",
  stepType: "email.send",
  gate: "gate.act",
  target: "ana@acme.test",
  itemIndex: null,
  payload: { to: "ana@acme.test", subject: "Hi", body: "Hello", account: "00000000-0000-4000-8000-0000000000aa" },
  payloadHash: "ab".repeat(32),
};

describe("a proposal on the Storm bot", () => {
  it("an email: From, its account, instead of the account's id", () => {
    const { text } = proposalMessage({ ...EMAIL, from: { address: "me@work.example", label: "Work" } }, { approvals: true });
    expect(text).toBe(
      "Storm · Replies: approve email.send?\nTarget: ana@acme.test\n\nFrom: me@work.example (Work)\nto: ana@acme.test\nsubject: Hi\nbody: Hello",
    );
  });

  it("an email without an account to send it from says so", () => {
    expect(proposalMessage({ ...EMAIL, from: null }, { approvals: true }).text).toContain("From: no email account to send it from");
  });

  it("anything else: its payload as it is", () => {
    expect(proposalMessage(EMAIL, { approvals: true }).text).toContain(`account: ${EMAIL.payload.account as string}`);
  });
});
