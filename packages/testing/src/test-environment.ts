import { randomBytes } from "node:crypto";

/**
 * The environment every integration test runs with. Set in Jest's globalSetup, so test workers inherit it.
 * Nothing comes from the developer's .env: the apps load .env only in main.ts and their CLI scripts.
 */
export class TestEnvironment {
  /** The seeded user's email (packages/db/prisma/seed.ts reads APP_ADMIN_EMAIL). */
  static readonly ADMIN_EMAIL = "me@storm.test";

  static apply(databaseUrl: string): void {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl;
    process.env.APP_ADMIN_EMAIL = TestEnvironment.ADMIN_EMAIL;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY_VERSION = "1";
    for (const name of Object.keys(process.env)) {
      if (/^ENCRYPTION_KEY_V\d+$/.test(name)) delete process.env[name];
    }
    delete process.env.APP_ADMIN_PASSWORD_HASH;
    delete process.env.APP_TOTP_SECRET;
    delete process.env.ANTHROPIC_API_KEY;
  }
}
