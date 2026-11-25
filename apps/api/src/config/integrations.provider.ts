import { KeyRing } from "@realentity/storm-crypto";
import { Integrations } from "@realentity/storm-db";
import { type Provider } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * M62: Claude and the model servers of Settings → AI, their secrets opened (docs/design.md §7: the api may).
 * Apart from server-env.ts, which PrismaService imports: importing PrismaService there would be circular.
 */
export const integrationsProvider: Provider = {
  provide: Integrations,
  inject: [PrismaService, KeyRing],
  useFactory: (prisma: PrismaService, keys: KeyRing): Integrations => new Integrations(prisma.client, keys),
};
