import { createPrismaConnection, type PrismaClient, type PrismaConnection } from "@realentity/storm-db";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type ServerEnv } from "@realentity/storm-shared";
import { SERVER_ENV } from "../config/server-env";

/** One Prisma client (and pg pool) per process. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly connection: PrismaConnection;

  constructor(@Inject(SERVER_ENV) env: ServerEnv) {
    this.connection = createPrismaConnection({ connectionString: env.DATABASE_URL });
  }

  get client(): PrismaClient {
    return this.connection.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.close();
  }
}
