import { type LlmChat } from "@ai-me/llm";
import { StepCatalog } from "@ai-me/steps";
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
 * for a scripted builder (null: as without ANTHROPIC_API_KEY).
 */
export async function createTestApp(
  options: { configured?: boolean; catalog?: StepCatalog; builderLlm?: LlmChat | null } = {},
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
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

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
