import { Module } from "@nestjs/common";
import { keyRingProvider } from "../config/server-env";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";

@Module({
  controllers: [CredentialsController],
  providers: [CredentialsService, keyRingProvider],
})
export class CredentialsModule {}
