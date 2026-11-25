import { KeyRing, sealIntegration } from "@realentity/storm-crypto";
import { createPrismaConnection } from "@realentity/storm-db";
import { type LlmChat } from "@realentity/storm-llm";
import { StepCatalog } from "@realentity/storm-steps";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { argon2id, hash } from "argon2";
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

/** No model set up: every integration gone. */
export async function withoutModels(): Promise<void> {
  const db = createPrismaConnection();
  try {
    await db.client.integration.deleteMany();
  } finally {
    await db.close();
  }
}
