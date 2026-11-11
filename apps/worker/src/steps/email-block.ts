import { type EmailMessage } from "@realentity/storm-steps";

/**
 * An email as the LLM sees it: headers that matter and the text, inside <email> (data, not instructions). `mine`: the
 * user wrote it (an earlier message of a thread).
 */
export function emailBlock(message: EmailMessage, textLimit?: number, index?: number, mine?: boolean): string {
  const text = textLimit && message.text.length > textLimit ? `${message.text.slice(0, textLimit)}\n[…]` : message.text;

  const attachments = message.attachments.map((a) => a.filename ?? a.contentType).join(", ");

  return [
    `<email${index === undefined ? "" : ` index="${index}"`}${mine ? ' mine="true"' : ""}>`,

    `From: ${message.fromName ? `${message.fromName} <${message.from}>` : message.from}`,

    `Date: ${message.date}`,

    `Subject: ${message.subject}`,

    ...(attachments ? [`Attachments: ${attachments}`] : []),

    "",

    text,

    "</email>",
  ].join("\n");
}
