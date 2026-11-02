import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BillsModule } from "./bills/bills.module";
import { BuilderModule } from "./builder/builder.module";
import { serverEnvProvider, SERVER_ENV } from "./config/server-env";
import { ControlsModule } from "./controls/controls.module";
import { CredentialsModule } from "./credentials/credentials.module";
import { DocumentsModule } from "./documents/documents.module";
import { EventsModule } from "./events/events.module";
import { PrismaService } from "./database/prisma.service";
import { HealthModule } from "./health/health.module";
import { FactsModule } from "./facts/facts.module";
import { GoogleModule } from "./google/google.module";
import { HooksModule } from "./hooks/hooks.module";
import { JobsModule } from "./jobs/jobs.module";
import { LearningModule } from "./learning/learning.module";
import { LiveModule } from "./live/live.module";
import { PipelinesModule } from "./pipelines/pipelines.module";
import { PricesModule } from "./prices/prices.module";
import { ProposalsModule } from "./proposals/proposals.module";
import { QueueModule } from "./queue/queue.module";
import { RunsModule } from "./runs/runs.module";
import { StepsModule } from "./steps/steps.module";
import { ViewsModule } from "./views/views.module";

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
    HooksModule,
    BillsModule,
    PricesModule,
    GoogleModule,
    FactsModule,
    HealthModule,
    ViewsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
