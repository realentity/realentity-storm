import { Module } from "@nestjs/common";
import { keyRingProvider } from "../config/server-env";
import { EmailAccountsController } from "./email-accounts.controller";
import { EmailAccountsService } from "./email-accounts.service";

@Module({
  controllers: [EmailAccountsController],
  providers: [EmailAccountsService, keyRingProvider],
})
export class EmailAccountsModule {}
