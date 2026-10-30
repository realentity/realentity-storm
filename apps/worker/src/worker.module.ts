import { Global, Module } from "@nestjs/common";
import { serverEnvProvider, SERVER_ENV } from "./config/server-env";
import { PrismaService } from "./database/prisma.service";
import { SecretsModule } from "./secrets/secrets.module";

@Global()
@Module({
  providers: [serverEnvProvider, PrismaService],
  exports: [SERVER_ENV, PrismaService],
})
export class CoreModule {}

/** Pipeline runner, steps and queue consumers join in M2. */
@Module({
  imports: [CoreModule, SecretsModule],
})
export class WorkerModule {}
