import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { serverEnvProvider, SERVER_ENV } from "./config/server-env";
import { CredentialsModule } from "./credentials/credentials.module";
import { PrismaService } from "./database/prisma.service";
import { HealthController } from "./health/health.controller";

@Global()
@Module({
  providers: [serverEnvProvider, PrismaService],
  exports: [SERVER_ENV, PrismaService],
})
export class CoreModule {}

@Module({
  imports: [CoreModule, ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]), AuthModule, CredentialsModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
