import { SealKeys } from "@realentity/storm-crypto";
import { parseServerEnv, type ServerEnv } from "@realentity/storm-shared";
import { type Provider } from "@nestjs/common";

export const SERVER_ENV = Symbol("SERVER_ENV");

/** Validated once at startup from process.env (main.ts loads the root .env first; tests set process.env). */
export const serverEnvProvider: Provider = {
  provide: SERVER_ENV,
  useFactory: (): ServerEnv => parseServerEnv(process.env),
};

/**
 * M64: what the api seals with, and the integration key it opens the connections' secrets with (M62); derived from the
 * root keys, which aren't kept. Nothing here opens a credential, a mail password, a Google token or a sealed field.
 */
export const sealKeysProvider: Provider = {
  provide: SealKeys,
  useFactory: (): SealKeys => SealKeys.fromEnv(process.env),
};
