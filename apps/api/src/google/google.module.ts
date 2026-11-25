import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { sealKeysProvider } from "../config/server-env";
import { GoogleClientService } from "./google-client.service";
import { GoogleController } from "./google.controller";
import { GOOGLE_FETCH, GoogleService } from "./google.service";

@Module({
  imports: [AuthModule],
  controllers: [GoogleController],
  providers: [GoogleService, GoogleClientService, sealKeysProvider, { provide: GOOGLE_FETCH, useValue: fetch }],
  exports: [GoogleService],
})
export class GoogleModule {}
