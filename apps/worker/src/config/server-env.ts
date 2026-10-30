import { parseServerEnv, type ServerEnv } from "@ai-me/shared";
import { type Provider } from "@nestjs/common";

export const SERVER_ENV = Symbol("SERVER_ENV");

/** Validated once at startup from process.env (main.ts loads the root .env first; tests set process.env). */
export const serverEnvProvider: Provider = {
  provide: SERVER_ENV,
  useFactory: (): ServerEnv => parseServerEnv(process.env),
};
