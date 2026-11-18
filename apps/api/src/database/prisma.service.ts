import { createPrismaConnection, type Prisma, type PrismaClient, type PrismaConnection } from "@realentity/storm-db";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type ServerEnv } from "@realentity/storm-shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { SERVER_ENV } from "../config/server-env";

interface Scope {
  client: PrismaClient;
  afterCommit: (() => Promise<void>)[];
}

/** A transaction as a client: a `$transaction` of the services called inside it joins it. */
function joined(tx: Prisma.TransactionClient): PrismaClient {
  const client: PrismaClient = new Proxy(tx, {
    get: (target, key, receiver) =>
      key === "$transaction"
        ? (work: unknown) => (typeof work === "function" ? (work as (c: PrismaClient) => unknown)(client) : Promise.all(work as Promise<unknown>[]))
        : (Reflect.get(target, key, receiver) as unknown),
  }) as PrismaClient;
  return client;
}

/** One Prisma client (and pg pool) per process. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly connection: PrismaConnection;
  private readonly scope = new AsyncLocalStorage<Scope>();

  constructor(@Inject(SERVER_ENV) env: ServerEnv) {
    this.connection = createPrismaConnection({ connectionString: env.DATABASE_URL });
  }

  get client(): PrismaClient {
    return this.scope.getStore()?.client ?? this.connection.client;
  }

  /** Several services' saves as one: everything `work` does through `client` is kept, or none of it. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return work();
    const afterCommit: Scope["afterCommit"] = [];
    const result = await this.connection.client.$transaction((tx) => this.scope.run({ client: joined(tx), afterCommit }, work), {
      maxWait: 10_000,
      timeout: 60_000,
    });
    for (const task of afterCommit) await task();
    return result;
  }

  /** What others act on (the worker's schedules, Telegram's commands) waits until a transaction's saves can be seen. */
  async afterCommit(task: () => Promise<void>): Promise<void> {
    const scope = this.scope.getStore();
    if (scope) scope.afterCommit.push(task);
    else await task();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.close();
  }
}
