import { KeyRing } from "@ai-me/crypto";
import { Module } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { CredentialVault } from "./credential-vault";
import { KeyRotation } from "./key-rotation";

@Module({
  providers: [
    { provide: KeyRing, useFactory: (): KeyRing => KeyRing.fromEnv(process.env) },
    {
      provide: CredentialVault,
      inject: [PrismaService, KeyRing],
      useFactory: (db: PrismaService, keys: KeyRing) => new CredentialVault(db.client, keys),
    },
    {
      provide: KeyRotation,
      inject: [PrismaService, KeyRing],
      useFactory: (db: PrismaService, keys: KeyRing) => new KeyRotation(db.client, keys),
    },
  ],
  exports: [CredentialVault, KeyRotation],
})
export class SecretsModule {}
