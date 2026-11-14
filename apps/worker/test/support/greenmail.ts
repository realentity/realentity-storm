import { KeyRing, seal } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";
import { randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export const MAILBOX = "me@storm.test";
/** The app password of the test mailbox: the S3 test greps every persisted value for it. */
export const APP_PASSWORD = "gm-app-password-7Qx9vL2p";
/** Someone the user writes to: a second mailbox, to read what the user sent her. */
export const OTHER_MAILBOX = "ana@acme.test";
export const OTHER_PASSWORD = "gm-ana-password-4Kd2";

export interface TestMailServer {
  host: string;
  imapPort: number;
  smtpPort: number;
  /** Puts a message into the mailbox, as any outside sender could. */
  deliver(mail: {
    from: string;
    /** Whose mailbox: the user's by default; OTHER_MAILBOX for Ana's (M50-T16: a second account). */
    to?: string;
    subject: string;
    text: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: { filename: string; content: string }[];
  }): Promise<string>;
  stop(): Promise<void>;
}

/**
 * M50-T7: one of the user's email accounts on the test server (plain text: it is local), its password sealed as the api
 * seals it. The first one is the default.
 */
export async function addEmailAccount(
  prisma: PrismaClient,
  userId: string,
  server: Pick<TestMailServer, "host" | "imapPort" | "smtpPort">,
  account: { address?: string; password?: string; isDefault?: boolean; imapHost?: string; tls?: boolean } = {},
): Promise<string> {
  const emailAccountId = randomUUID();
  await prisma.emailAccount.create({
    data: {
      emailAccountId,
      userId,
      address: account.address ?? MAILBOX,
      imapHost: account.imapHost ?? server.host,
      imapPort: server.imapPort,
      smtpHost: account.imapHost ?? server.host,
      smtpPort: server.smtpPort,
      tls: account.tls ?? false,
      isDefault: account.isDefault ?? (await prisma.emailAccount.count({ where: { userId } })) === 0,
      ...seal(KeyRing.fromEnv(process.env), emailAccountId, account.password ?? APP_PASSWORD),
    },
  });
  return emailAccountId;
}

/** GreenMail (IMAP + SMTP, plain text, local only) with the user's mailbox and Ana's, each logging in with its full address. */
export async function startMailServer(): Promise<TestMailServer> {
  const container: StartedTestContainer = await new GenericContainer("greenmail/standalone:2.1.3")
    .withEnvironment({
      GREENMAIL_OPTS: [
        "-Dgreenmail.setup.test.smtp",
        "-Dgreenmail.setup.test.imap",
        "-Dgreenmail.hostname=0.0.0.0",
        `-Dgreenmail.users=${[
          [MAILBOX, APP_PASSWORD],
          [OTHER_MAILBOX, OTHER_PASSWORD],
        ]
          .map(([address, password]) => `${address.split("@")[0]}:${password}@${address.split("@")[1]}`)
          .join(",")}`,
        "-Dgreenmail.users.login=email",
      ].join(" "),
    })
    .withExposedPorts(3025, 3143)
    .withWaitStrategy(Wait.forLogMessage(/Starting GreenMail standalone/))
    .start();
  const host = container.getHost();
  const smtpPort = container.getMappedPort(3025);
  // GreenMail logs before its sockets accept connections.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  return {
    host,
    imapPort: container.getMappedPort(3143),
    smtpPort,
    async deliver(mail) {
      const transport = createTransport({ host, port: smtpPort, secure: false, ignoreTLS: true });
      try {
        const info = await transport.sendMail({ to: MAILBOX, ...mail });
        return String(info.messageId);
      } finally {
        transport.close();
      }
    },
    stop: async () => {
      await container.stop();
    },
  };
}
