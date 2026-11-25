import { Module } from "@nestjs/common";
import { sealKeysProvider } from "../config/server-env";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";

@Module({
  controllers: [CredentialsController],
  providers: [CredentialsService, sealKeysProvider],
})
export class CredentialsModule {}
