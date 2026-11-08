import { JobQueue } from "@realentity/storm-queue";
import { type ServerEnv } from "@realentity/storm-shared";
import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";

@Injectable()
class QueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(JobQueue) private readonly queue: JobQueue) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.stop();
  }
}

/** The api only sends jobs (resume after a decision, manual runs, schedule sync); the worker consumes them. */
@Global()
@Module({
  providers: [
    {
      provide: JobQueue,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv): Promise<JobQueue> => {
        const logger = new Logger("Queue");
        return JobQueue.start({
          connectionString: env.DATABASE_URL,
          role: "api",
          onError: (error) => logger.error(error.message, error.stack),
        });
      },
    },
    QueueLifecycle,
  ],
  exports: [JobQueue],
})
export class QueueModule {}
