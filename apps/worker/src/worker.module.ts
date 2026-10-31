import { Global, Module } from "@nestjs/common";
import { serverEnvProvider, SERVER_ENV } from "./config/server-env";
import { PrismaService } from "./database/prisma.service";
import { Heartbeat } from "./health/heartbeat";
import { JobsModule } from "./jobs/jobs.module";
import { SecretsModule } from "./secrets/secrets.module";

@Global()
@Module({
  providers: [serverEnvProvider, PrismaService],
  exports: [SERVER_ENV, PrismaService],
})
export class CoreModule {}

/** Credentials (decrypted only here), the pipeline runner and the queue consumers. */
@Module({
  imports: [CoreModule, SecretsModule, JobsModule],
  providers: [Heartbeat],
})
export class WorkerModule {}
