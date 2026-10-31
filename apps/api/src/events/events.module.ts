import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EventsService } from "./events.service";

/** Global: the services that change runs, proposals or the kill switch publish through it. */
@Global()
@Module({
  imports: [AuthModule],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
