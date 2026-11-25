import { KeyRing, sealIntegration } from "@realentity/storm-crypto";
import { createPrismaConnection, Integrations } from "@realentity/storm-db";
import { type LlmChat } from "@realentity/storm-llm";
import { StepCatalog } from "@realentity/storm-steps";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { argon2id, hash } from "argon2";
import { createHash } from "node:crypto";
import { authenticator } from "otplib";
import request from "supertest";
import { type App } from "supertest/types";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/bootstrap";
import { BUILDER_LLM } from "../../src/builder/builder.service";

export const TEST_PASSWORD = "correct horse battery staple";

let passwordHash: string | undefined;

export interface TestApp {
  app: INestApplication;
  /** The HTTP server, typed for supertest. */
  http: App;
  totpSecret: string;
  /** A supertest agent that keeps cookies, already signed in. */
  signedIn(): Promise<ReturnType<typeof request.agent>>;
  close(): Promise<void>;
}

/**
 * A fresh api (own throttler storage and TOTP replay state) with a known password and TOTP secret.
 * Pass `configured: false` for an api whose login is not set up yet, `catalog` to add test steps, and `builderLlm`
 * for a scripted builder (null: as without a model). With a scripted builder, the user has Claude set up in Settings →
 * AI (M62), with a made-up key the script never sends anywhere.
 */
export async function createTestApp(
  options: {
    configured?: boolean;
    catalog?: StepCatalog;
    builderLlm?: LlmChat | null;
    /** Other providers replaced, e.g. TELEGRAM_FETCH. */
    overrides?: { provide: unknown; useValue: unknown }[];
  } = {},
): Promise<TestApp> {
  const totpSecret = authenticator.generateSecret();
  if (options.configured === false) {
    delete process.env.APP_ADMIN_PASSWORD_HASH;
    delete process.env.APP_TOTP_SECRET;
  } else {
    passwordHash ??= await hash(TEST_PASSWORD, { type: argon2id });
    process.env.APP_ADMIN_PASSWORD_HASH = passwordHash;
    process.env.APP_TOTP_SECRET = totpSecret;
  }

  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.catalog) builder.overrideProvider(StepCatalog).useValue(options.catalog);
  if (options.builderLlm !== undefined) builder.overrideProvider(BUILDER_LLM).useValue(options.builderLlm);
  for (const { provide, useValue } of options.overrides ?? []) builder.overrideProvider(provide).useValue(useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  if (options.builderLlm) await withClaude();
  else if (options.builderLlm === null) await withoutModels();
  // Seeded behind the api's back: its cache (filled at startup, e.g. by the bot's menu, M63) forgets.
  app.get(Integrations).forget();

  const http = app.getHttpServer() as App;

  return {
    app,
    http,
    totpSecret,
    async signedIn() {
      const agent = request.agent(http);
      await agent
        .post("/api/auth/login")
        .send({ password: TEST_PASSWORD, totp: authenticator.generate(totpSecret) })
        .expect(200);
      return agent;
    },
    close: () => app.close(),
  };
}

/** M62: Claude set up for the seeded user, as Settings → AI does it (a made-up key, sealed). */
export async function withClaude(): Promise<void> {
  const db = createPrismaConnection();
  try {
    const user = await db.client.user.findFirstOrThrow({ orderBy: { dateCreated: "asc" } });
    if (await db.client.integration.findFirst({ where: { userId: user.userId, kind: "CLAUDE" } })) return;
    const integrationId = "00000000-0000-4000-8000-00000000c1a0";
    await db.client.integration.create({
      data: { integrationId, userId: user.userId, kind: "CLAUDE", name: "Claude", secretHint: "…-key", ...sealIntegration(KeyRing.fromEnv(process.env), integrationId, "sk-ant-test-not-a-real-key") },
    });
  } finally {
    await db.close();
  }
}

/** No model set up: Claude and every model server gone. */
export async function withoutModels(): Promise<void> {
  const db = createPrismaConnection();
  try {
    await db.client.integration.deleteMany({ where: { kind: { in: ["CLAUDE", "OPENAI_COMPATIBLE"] } } });
  } finally {
    await db.close();
  }
}

/**
 * M63: one connection of the seeded user as Settings saves it (its secret sealed, a webhook secret as its hash), or
 * none (null); the api's cache forgets, so the next request sees it.
 */
async function withIntegration(
  api: { app: INestApplication },
  kind: "TELEGRAM" | "GOOGLE_OAUTH",
  row: { secret: string; config: Record<string, string>; secretHash?: string } | null,
): Promise<void> {
  const db = createPrismaConnection();
  try {
    const user = await db.client.user.findFirstOrThrow({ orderBy: { dateCreated: "asc" } });
    await db.client.integration.deleteMany({ where: { userId: user.userId, kind } });
    if (row) {
      const integrationId = kind === "TELEGRAM" ? "00000000-0000-4000-8000-0000000007e1" : "00000000-0000-4000-8000-000000000900";
      await db.client.integration.create({
        data: {
          integrationId,
          userId: user.userId,
          kind,
          name: kind === "TELEGRAM" ? "Telegram" : "Google",
          config: row.config,
          secretHint: `…${row.secret.slice(-4)}`,
          secretHash: row.secretHash ?? null,
          ...sealIntegration(KeyRing.fromEnv(process.env), integrationId, row.secret),
        },
      });
    }
  } finally {
    await db.close();
  }
  api.app.get(Integrations).forget();
}

/** M63: the Storm bot of Settings → Telegram: a made-up token, your chat, the webhook secret (kept as its hash). */
export function withTelegram(api: { app: INestApplication }, bot: { botToken: string; chatId: string; webhookSecret?: string } | null): Promise<void> {
  return withIntegration(
    api,
    "TELEGRAM",
    bot && {
      secret: bot.botToken,
      config: { chatId: bot.chatId },
      ...(bot.webhookSecret ? { secretHash: createHash("sha256").update(bot.webhookSecret).digest("hex") } : {}),
    },
  );
}

/** M63: Google's OAuth client of Settings → Google (made-up values). */
export function withGoogleClient(api: { app: INestApplication }, client: { clientId: string; clientSecret: string } | null): Promise<void> {
  return withIntegration(api, "GOOGLE_OAUTH", client && { secret: client.clientSecret, config: { clientId: client.clientId } });
}
