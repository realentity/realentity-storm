import { argon2id, hash } from "argon2";
import { config } from "dotenv";
import { authenticator } from "otplib";
import { toString as qrToString } from "qrcode";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

config({ path: resolve(__dirname, "../../../../.env"), quiet: true });

/**
 * pnpm auth:setup: asks for a password (not echoed), prints APP_ADMIN_PASSWORD_HASH and a new APP_TOTP_SECRET with a
 * QR code for the authenticator app. Nothing is written anywhere: copy the two lines into .env yourself.
 */
async function main(): Promise<void> {
  const password = await askHidden("New password (min 12 characters): ");
  if (password.length < 12) throw new Error("The password must have at least 12 characters");
  const repeated = await askHidden("Repeat: ");
  if (repeated !== password) throw new Error("The passwords differ");

  const passwordHash = await hash(password, { type: argon2id });
  const secret = authenticator.generateSecret(20);
  const email = process.env.APP_ADMIN_EMAIL || "me@localhost";
  const uri = authenticator.keyuri(email, "AI ME", secret);

  process.stdout.write("\nScan with your authenticator app:\n\n");
  process.stdout.write(await qrToString(uri, { type: "terminal", small: true }));
  process.stdout.write(`\nOr enter the secret manually: ${secret}\n\nPut these two lines into .env (single quotes keep the $ signs):\n\n`);
  process.stdout.write(`APP_ADMIN_PASSWORD_HASH='${passwordHash}'\nAPP_TOTP_SECRET=${secret}\n\n`);
}

/** Reads a line without echoing it to the terminal. */
function askHidden(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolvePromise) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer);
    });
    muted = true;
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
