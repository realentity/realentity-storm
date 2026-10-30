import { KeyRing } from "@ai-me/crypto";
import { parseServerEnv, type ServerEnv } from "@ai-me/shared";
import { type Provider } from "@nestjs/common";

export const SERVER_ENV = Symbol("SERVER_ENV");

/** Validated once at startup from process.env (main.ts loads the root .env first; tests set process.env). */
export const serverEnvProvider: Provider = {
  provide: SERVER_ENV,
  useFactory: (): ServerEnv => parseServerEnv(process.env),
};

/** The root keys. The api uses them only to seal (encrypt) credentials. */
export const keyRingProvider: Provider = {
  provide: KeyRing,
  useFactory: (): KeyRing => KeyRing.fromEnv(process.env),
};
