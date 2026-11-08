import "reflect-metadata";
import "source-map-support/register";
import { config } from "dotenv";
import { resolve } from "node:path";
import { type ServerEnv } from "@realentity/storm-shared";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./bootstrap";
import { SERVER_ENV } from "./config/server-env";

// One .env in the repository root is shared by api, worker and packages/db.
config({ path: resolve(__dirname, "../../../.env"), quiet: true });

async function bootstrap(): Promise<void> {
  // rawBody: webhooks are signed over the bytes as sent (M12-T2).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Behind Caddy on the server: trust the first proxy so request.ip is the client (throttling, session audit).
  app.set("trust proxy", 1);
  configureApp(app);

  const env = app.get<ServerEnv>(SERVER_ENV);
  await app.listen(env.API_PORT, env.API_HOST);
  Logger.log(`Storm api listening on http://${env.API_HOST}:${env.API_PORT}/api (${env.NODE_ENV})`, "Bootstrap");
  if (!env.APP_ADMIN_PASSWORD_HASH || !env.APP_TOTP_SECRET) {
    Logger.warn("Login is not configured yet: run pnpm auth:setup and put the values in .env", "Bootstrap");
  }
}

bootstrap().catch((error: unknown) => {
  console.error("Api failed to start", error);
  process.exit(1);
});
