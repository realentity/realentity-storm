import { Global, Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BillsModule } from "./bills/bills.module";
import { BuilderModule } from "./builder/builder.module";
import { BundlesModule } from "./bundles/bundles.module";
import { ExamplesModule } from "./examples/examples.module";
import { integrationsProvider } from "./config/integrations.provider";
import { sealKeysProvider, serverEnvProvider, SERVER_ENV } from "./config/server-env";
import { ControlsModule } from "./controls/controls.module";
import { CredentialsModule } from "./credentials/credentials.module";
import { EmailAccountsModule } from "./email-accounts/email-accounts.module";
import { DocumentsModule } from "./documents/documents.module";
import { EventsModule } from "./events/events.module";
import { PrismaService } from "./database/prisma.service";
import { HealthModule } from "./health/health.module";
import { FactsModule } from "./facts/facts.module";
import { TopicsModule } from "./topics/topics.module";
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
import { AppsModule } from "./apps/apps.module";
import { StepsModule } from "./steps/steps.module";
import { ViewsModule } from "./views/views.module";
import { MaskSealedInterceptor } from "./mask-sealed.interceptor";
import { IntegrationsModule } from "./integrations/integrations.module";
import { Integrations } from "@realentity/storm-db";

@Global()
@Module({
  // M62: the connections in Settings → AI (Claude, model servers), read by the builder, Settings and the Examples.
  providers: [serverEnvProvider, PrismaService, sealKeysProvider, integrationsProvider],
  exports: [SERVER_ENV, PrismaService, Integrations],
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
    EmailAccountsModule,
    PipelinesModule,
    ProposalsModule,
    RunsModule,
    ControlsModule,
    IntegrationsModule,
    LearningModule,
    BuilderModule,
    BundlesModule,
    ExamplesModule,
    LiveModule,
    JobsModule,
    DocumentsModule,
    HooksModule,
    BillsModule,
    PricesModule,
    GoogleModule,
    FactsModule,
    TopicsModule,
    HealthModule,
    ViewsModule,
    AppsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // M52: no answer carries an encrypted field's sealed value, whichever endpoint reads it.
    { provide: APP_INTERCEPTOR, useClass: MaskSealedInterceptor },
  ],
})
export class AppModule {}
