import { createPrismaConnection, type PrismaClient, type PrismaConnection } from "@ai-me/db";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { type ServerEnv } from "@ai-me/shared";
import { SERVER_ENV } from "../config/server-env";

/** One Prisma client (and pg pool) per process. Closed last on shutdown, after the queue stopped running jobs. */
@Injectable()
export class PrismaService implements OnApplicationShutdown {
  private readonly connection: PrismaConnection;

  constructor(@Inject(SERVER_ENV) env: ServerEnv) {
    this.connection = createPrismaConnection({ connectionString: env.DATABASE_URL });
  }

  get client(): PrismaClient {
    return this.connection.client;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
