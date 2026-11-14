import { z } from "zod";
import { HOST_PATTERN, type CredentialUse } from "./credentials";

/**
 * M50-T7: the user's mailboxes, in Settings: several, one the default. Gmail with an app password (2-step verification
 * on, then myaccount.google.com/apppasswords), or any server with IMAP and SMTP over TLS. Email steps read and send
 * through one of them: the one a step's `account` slot is filled with, the one a message came from, else the default.
 */

/** Hosts a test server may run on without TLS (a local GreenMail). */
export const LOCAL_MAIL_HOSTS = ["localhost", "127.0.0.1"];

export const EMAIL_PRESETS = {
  gmail: { label: "Gmail (app password)", imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
} as const;

export interface EmailAccountView {
  emailAccountId: string;
  address: string;
  label: string | null;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  tls: boolean;
  isDefault: boolean;
  lastUsedAt: string | null;
  /** M50-T7: the pipelines and Apps whose email slot is filled with it. */
  usedBy: CredentialUse[];
}

const Host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(new RegExp(`${HOST_PATTERN.source}|^127\\.0\\.0\\.1$`), "a host, e.g. imap.gmail.com");
const Port = z.coerce.number().int().min(1).max(65_535);

export const EmailAccountRequestSchema = z
  .object({
    address: z.string().trim().toLowerCase().email("an email address"),
    label: z.string().trim().max(60).optional(),
    imapHost: Host,
    imapPort: Port.default(993),
    smtpHost: Host,
    smtpPort: Port.default(465),
    tls: z.boolean().default(true),
    /** The app password: stored sealed, never shown again. */
    password: z.string().min(1).max(500),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine((a) => a.tls || (LOCAL_MAIL_HOSTS.includes(a.imapHost) && LOCAL_MAIL_HOSTS.includes(a.smtpHost)), {
    message: "TLS can be off only for a test server on this machine",
    path: ["tls"],
  });
export type EmailAccountRequest = z.input<typeof EmailAccountRequestSchema>;

/** Changing one: its label, or making it the default; a new password replaces the old. */
export const EmailAccountUpdateSchema = z
  .object({
    label: z.string().trim().max(60).nullable().optional(),
    isDefault: z.literal(true).optional(),
    password: z.string().min(1).max(500).optional(),
  })
  .strict();
export type EmailAccountUpdate = z.infer<typeof EmailAccountUpdateSchema>;
