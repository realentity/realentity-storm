import { TELEGRAM_MAX_TEXT, type TelegramButton, type TelegramMessage } from "./telegram";

/**
 * A proposal on the Storm bot (M12-T4). Approve is offered only when the message holds the whole payload, and its
 * button carries the start of the payload's hash: a payload that changed since the message was sent isn't approved.
 */
export interface ProposalForTelegram {
  proposalId: string;
  pipeline: string;
  /** The step that acts (gate.act), or the review step (gate.review). */
  stepType: string;
  gate: "gate.act" | "gate.review";
  target: string;
  itemIndex: number | null;
  payload: Record<string, unknown>;
  /** SHA-256 of the payload, hex. */
  payloadHash: string;
  /**
   * An email's sender (email.send): the account it goes out from, said as From instead of the payload's `account` id;
   * null: no account to send it from. Absent for any other step.
   */
  from?: { address: string; label: string | null } | null;
}

/** Room left for the header and Telegram's own limit (4096). */
const MAX_PAYLOAD_TEXT = 3500;
const HASH_CHARS = 16;

export type ProposalCallback = { action: "approve"; proposalId: string; hash: string } | { action: "reject"; proposalId: string };

export function parseProposalCallback(data: string): ProposalCallback | null {
  const approve = /^a:([0-9a-f-]{36}):([0-9a-f]{16})$/.exec(data);
  if (approve) return { action: "approve", proposalId: approve[1], hash: approve[2] };
  const reject = /^r:([0-9a-f-]{36})$/.exec(data);
  return reject ? { action: "reject", proposalId: reject[1] } : null;
}

export function hashMatches(payloadHash: string, shown: string): boolean {
  return payloadHash.slice(0, HASH_CHARS) === shown;
}

/** The message for a proposal waiting for the user; `approvals: false` (the setting) leaves only Open. */
export function proposalMessage(proposal: ProposalForTelegram, options: { approvals: boolean; appOrigin?: string }): TelegramMessage {
  const payload = shownText(proposal);
  const complete = payload.length <= MAX_PAYLOAD_TEXT;
  const item = proposal.itemIndex === null ? "" : ` (item ${proposal.itemIndex + 1})`;
  const header =
    proposal.gate === "gate.review"
      ? `Storm · ${proposal.pipeline}: pick what goes on${item}`
      : `Storm · ${proposal.pipeline}: approve ${proposal.stepType}${item}?\nTarget: ${proposal.target}`;
  const text = `${header}\n\n${complete ? payload : `${payload.slice(0, MAX_PAYLOAD_TEXT)}…\n\n(Too long to show in full: open it to decide.)`}`;

  const row: TelegramButton[] = [];
  if (options.approvals && proposal.gate === "gate.act") {
    if (complete) row.push({ text: "Approve", data: `a:${proposal.proposalId}:${proposal.payloadHash.slice(0, HASH_CHARS)}` });
    row.push({ text: "Reject", data: `r:${proposal.proposalId}` });
  }
  if (options.appOrigin) row.push({ text: "Open", url: `${options.appOrigin}/proposals/${proposal.proposalId}` });
  return { text, buttons: row.length ? [row] : [] };
}

/** The message once decided: what happened, then what it was, without buttons. */
export function decidedMessage(proposal: ProposalForTelegram, outcome: string): TelegramMessage {
  const { text } = proposalMessage(proposal, { approvals: false });
  return { text: `${outcome}\n\n${text}`.slice(0, TELEGRAM_MAX_TEXT), buttons: [] };
}

/** An email's sender first and its fields without the account's id; any other payload as it is. */
function shownText(proposal: ProposalForTelegram): string {
  if (proposal.from === undefined) return payloadText(proposal.payload);
  const { account: _account, ...rest } = proposal.payload;
  const from = proposal.from
    ? `From: ${proposal.from.address}${proposal.from.label ? ` (${proposal.from.label})` : ""}`
    : "From: no email account to send it from (Settings → Email accounts)";
  return `${from}\n${payloadText(rest)}`;
}

/** Every field, as it will be sent: text as it is, anything else as JSON. */
export function payloadText(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([key, value]) => {
      if (typeof value === "string") return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`;
      return `${key}: ${JSON.stringify(value, null, 1)}`;
    })
    .join("\n");
}
