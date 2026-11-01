import { Module } from "@nestjs/common";
import { keyRingProvider } from "../config/server-env";
import { GoogleController } from "./google.controller";
import { GOOGLE_FETCH, GoogleService } from "./google.service";

@Module({
  controllers: [GoogleController],
  providers: [GoogleService, keyRingProvider, { provide: GOOGLE_FETCH, useValue: fetch }],
  exports: [GoogleService],
})
export class GoogleModule {}
