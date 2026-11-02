import { Module } from "@nestjs/common";
import { HealthChecks } from "./health-checks";
import { HealthController } from "./health.controller";
import { WorkerWatchdog } from "./worker-watchdog";

/** The api's own health, the worker's watchdog, and what the server's jobs report (M26). */
@Module({
  controllers: [HealthController],
  providers: [WorkerWatchdog, HealthChecks],
  exports: [WorkerWatchdog, HealthChecks],
})
export class HealthModule {}
