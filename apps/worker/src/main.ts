import "reflect-metadata";
import "source-map-support/register";
import { config } from "dotenv";
import { resolve } from "node:path";
import { type ServerEnv } from "@ai-me/shared";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SERVER_ENV } from "./config/server-env";
import { WorkerModule } from "./worker.module";

// One .env in the repository root is shared by api, worker and packages/db.
config({ path: resolve(__dirname, "../../../.env"), quiet: true });

/** Standalone Nest application: no HTTP server. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const env = app.get<ServerEnv>(SERVER_ENV);
  Logger.log(`AI ME worker started (${env.NODE_ENV})`, "Bootstrap");
}

bootstrap().catch((error: unknown) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
