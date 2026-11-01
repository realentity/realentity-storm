import "reflect-metadata";
import { defaultCatalog, StepCatalog } from "@ai-me/steps";
import { DatabasePreparer, TestEnvironment, TestInfrastructure } from "@ai-me/testing";
import { type INestApplication, type INestApplicationContext, type Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { argon2id, hash } from "argon2";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { authenticator } from "otplib";
import { TEST_BUILDER_LLM } from "./test-builder";
import { TEST_EXECUTORS, TEST_STEPS } from "./test-steps";

export const API_PORT = 3199;
export const WEB_PORT = 5179;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const PASSWORD = "e2e correct horse battery staple";
export const STORAGE_STATE = resolve(__dirname, "../.auth/state.json");
/** Read by the tests (they run in other processes): the login test needs the TOTP secret. */
export const STACK_ENV = { totpSecret: "E2E_TOTP_SECRET" } as const;

const APPS = resolve(__dirname, "../..");

interface Stack {
  infrastructure: TestInfrastructure;
  api: INestApplication;
  worker: INestApplicationContext;
}

/** The compiled apps (dist), so Nest gets its decorator metadata; started with the test steps added. */
async function dist<T>(path: string): Promise<T> {
  return (await import(resolve(APPS, path))) as T;
}

/**
 * PostgreSQL (Testcontainers, or E2E_INFRA=local), migrated and seeded; the api on API_PORT and the worker, both
 * in this process; and a signed-in session saved as Playwright storage state (logins would use up TOTP codes).
 */
export async function startStack(): Promise<Stack> {
  const infrastructure = TestInfrastructure.fromEnvironment();
  const databaseUrl = await infrastructure.start();
  try {
    TestEnvironment.apply(databaseUrl);
    process.env.API_HOST = "127.0.0.1";
    process.env.API_PORT = String(API_PORT);
    // Uploads (Profile → Documents) go to a folder of this run's own.
    process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "aime-e2e-documents-"));
    process.env.APP_ADMIN_PASSWORD_HASH = await hash(PASSWORD, { type: argon2id });
    process.env.APP_TOTP_SECRET = authenticator.generateSecret();
    process.env[STACK_ENV.totpSecret] = process.env.APP_TOTP_SECRET;
    await new DatabasePreparer().prepare(databaseUrl);

    const catalog = defaultCatalog().with(...TEST_STEPS);
    const { AppModule } = await dist<{ AppModule: Type }>("api/dist/app.module.js");
    const { configureApp } = await dist<{ configureApp: (app: INestApplication) => void }>("api/dist/bootstrap.js");
    const { BUILDER_LLM } = await dist<{ BUILDER_LLM: symbol }>("api/dist/builder/builder.service.js");
    const apiModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StepCatalog)
      .useValue(catalog)
      .overrideProvider(BUILDER_LLM)
      .useValue(TEST_BUILDER_LLM)
      .compile();
    const api = apiModule.createNestApplication({ rawBody: true });
    configureApp(api);
    await api.listen(API_PORT, "127.0.0.1");

    const { WorkerModule } = await dist<{ WorkerModule: Type }>("worker/dist/worker.module.js");
    const { STEP_EXECUTORS } = await dist<{ STEP_EXECUTORS: symbol }>("worker/dist/jobs/jobs.module.js");
    const { ExecutorRegistry } = await dist<{ ExecutorRegistry: new (executors: unknown[]) => unknown }>(
      "worker/dist/runner/step-executor.js",
    );
    const worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(StepCatalog)
      .useValue(catalog)
      .overrideProvider(ExecutorRegistry)
      .useFactory({
        inject: [STEP_EXECUTORS],
        factory: (core: { type: string }[]) => {
          const standIns = new Set(TEST_EXECUTORS.map((e) => e.type));
          return new ExecutorRegistry([...core.filter((e) => !standIns.has(e.type)), ...TEST_EXECUTORS]);
        },
      })
      .compile();
    await worker.init();

    await saveSession(api);
    return { infrastructure, api, worker };
  } catch (error) {
    await infrastructure.stop();
    throw error;
  }
}

export async function stopStack(stack: Stack): Promise<void> {
  await stack.worker.close();
  await stack.api.close();
  await stack.infrastructure.stop();
}

/** A session for the seeded user, as the browser would hold it after signing in. */
async function saveSession(api: INestApplication): Promise<void> {
  const { SessionService } = await dist<{ SessionService: Type }>("api/dist/auth/session.service.js");
  const { createPrismaConnection } = await import("@ai-me/db");
  const db = createPrismaConnection();
  const user = await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } });
  await db.close();
  const sessions = api.get<{ create(userId: string, meta: object): Promise<{ token: string; expiresAt: Date }> }>(SessionService);
  const { token, expiresAt } = await sessions.create(user.userId, { userAgent: "playwright" });
  const state = {
    cookies: [
      {
        name: "aime_session",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        expires: Math.floor(expiresAt.getTime() / 1000),
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      },
    ],
    origins: [],
  };
  await mkdir(dirname(STORAGE_STATE), { recursive: true });
  await writeFile(STORAGE_STATE, JSON.stringify(state, null, 2));
}
