import { type EmailMessage } from "./catalog";

/**
 * Who can't be answered: an address nobody reads (no-reply, a mailer daemon, a bounce address), or mail the user sent
 * to themselves (Storm's own messages, notes). Replies to them are never drafted nor sent.
 */
const NO_REPLY = /(^|[._+-])(no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|postmaster|bounces?)([._+-]|$)|noreply|donotreply/i;

export function isNoReplyAddress(address: string): boolean {
  const local = address.trim().toLowerCase().split("@")[0] ?? "";
  return NO_REPLY.test(local);
}

/** Why this email can't be answered, or null when it can: its sender is a no-reply address, or it is the user's to themselves. */
export function unanswerable(message: Pick<EmailMessage, "from" | "to">): string | null {
  const from = message.from.trim().toLowerCase();
  if (!from) return "it has no sender";
  if (isNoReplyAddress(from)) return `${message.from} is a no-reply address`;
  if (message.to.some((to) => to.trim().toLowerCase() === from)) return "it was sent to its own sender";
  return null;
}
