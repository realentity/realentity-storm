import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BuilderModule } from "./builder/builder.module";
import { serverEnvProvider, SERVER_ENV } from "./config/server-env";
import { ControlsModule } from "./controls/controls.module";
import { CredentialsModule } from "./credentials/credentials.module";
import { DocumentsModule } from "./documents/documents.module";
import { EventsModule } from "./events/events.module";
import { PrismaService } from "./database/prisma.service";
import { HealthController } from "./health/health.controller";
import { JobsModule } from "./jobs/jobs.module";
import { WorkerWatchdog } from "./health/worker-watchdog";
import { LearningModule } from "./learning/learning.module";
import { LiveModule } from "./live/live.module";
import { PipelinesModule } from "./pipelines/pipelines.module";
import { ProposalsModule } from "./proposals/proposals.module";
import { QueueModule } from "./queue/queue.module";
import { RunsModule } from "./runs/runs.module";
import { StepsModule } from "./steps/steps.module";

@Global()
@Module({
  providers: [serverEnvProvider, PrismaService],
  exports: [SERVER_ENV, PrismaService],
})
export class CoreModule {}

@Module({
  imports: [
    CoreModule,
    QueueModule,
    StepsModule,
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
    AuthModule,
    EventsModule,
    CredentialsModule,
    PipelinesModule,
    ProposalsModule,
    RunsModule,
    ControlsModule,
    LearningModule,
    BuilderModule,
    LiveModule,
    JobsModule,
    DocumentsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }, WorkerWatchdog],
})
export class AppModule {}
