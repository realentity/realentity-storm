import { type EmailMessage } from "@realentity/storm-steps";
import { mailWho, type MailConnector } from "../mail/mail-connector";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { textOf } from "./file-steps";

/** A message bigger than this is read without its attachments (said in `problems`). */
const MAX_MESSAGE_BYTES = 10 * 1_048_576;

/** The kinds textOf reads: text files, PDFs, Word documents. */
function readable(attachment: { filename: string | null; contentType: string }): boolean {
  const name = attachment.filename ?? "";
  return (
    attachment.contentType.startsWith("text/") ||
    attachment.contentType === "application/pdf" ||
    attachment.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.(pdf|docx|txt|md|csv)$/i.test(name)
  );
}

interface AttachmentsInput {
  messages: EmailMessage[];
  mailbox: string;
  maxFiles: number;
  maxChars: number;
}

/**
 * email.attachments (M71): the text of each email's readable attachments, for llm.extract to read with the email
 * (a bill's PDF, an invoice). Only what the email lists as readable is fetched; a file that can't be read is left out
 * and said, never a failure.
 */
export class EmailAttachmentsStep implements StepExecutor {
  readonly type = "email.attachments";

  constructor(private readonly mail: MailConnector) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { messages, mailbox, maxFiles, maxChars } = input as unknown as AttachmentsInput;
    const problems: string[] = [];
    let read = 0;
    const out = [];
    for (const message of messages) {
      const files: { filename: string | null; contentType: string; text: string; truncated: boolean }[] = [];
      if (message.attachments.some(readable)) {
        try {
          const attachments = await this.mail.attachments(mailWho(context, message.account), { mailbox, uid: message.uid, maxBytes: MAX_MESSAGE_BYTES });
          for (const attachment of attachments.filter(readable).slice(0, maxFiles)) {
            const name = attachment.filename ?? "attachment";
            try {
              const text = (await textOf(attachment.contentType, attachment.content, name)).trim();
              if (!text) continue;
              files.push({ filename: attachment.filename, contentType: attachment.contentType, text: text.slice(0, maxChars), truncated: text.length > maxChars });
              read++;
            } catch (error) {
              problems.push(`${message.subject}: ${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          problems.push(`${message.subject}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const attachmentText = files.map((f) => `--- ${f.filename ?? "attachment"} ---\n${f.text}`).join("\n\n");
      out.push({ ...message, files, attachmentText });
    }
    return { messages: out, read, problems };
  }
}
