import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { sealKeysProvider } from "../config/server-env";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";

/** M62: the connections Storm itself uses (Settings → AI → Model servers). */
@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, sealKeysProvider],
})
export class IntegrationsModule {}
