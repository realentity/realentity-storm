import { createTransport } from "nodemailer";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export const MAILBOX = "me@aime.test";
/** The app password of the test mailbox: the S3 test greps every persisted value for it. */
export const APP_PASSWORD = "gm-app-password-7Qx9vL2p";

export interface TestMailServer {
  host: string;
  imapPort: number;
  smtpPort: number;
  /** Puts a message into the mailbox, as any outside sender could. */
  deliver(mail: {
    from: string;
    subject: string;
    text: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: { filename: string; content: string }[];
  }): Promise<string>;
  stop(): Promise<void>;
}

/** GreenMail (IMAP + SMTP, plain text, local only) with one mailbox that logs in with its full address. */
export async function startMailServer(): Promise<TestMailServer> {
  const container: StartedTestContainer = await new GenericContainer("greenmail/standalone:2.1.3")
    .withEnvironment({
      GREENMAIL_OPTS: [
        "-Dgreenmail.setup.test.smtp",
        "-Dgreenmail.setup.test.imap",
        "-Dgreenmail.hostname=0.0.0.0",
        `-Dgreenmail.users=${MAILBOX.split("@")[0]}:${APP_PASSWORD}@${MAILBOX.split("@")[1]}`,
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
