import { type AppEvent } from "@realentity/storm-shared";
import { Client } from "pg";

/** Postgres NOTIFY channel: the worker and the api publish, the api forwards to the web app. */
export const EVENTS_CHANNEL = "storm_events";

/** An event addressed to one user. */
export interface UserEvent {
  userId: string;
  event: AppEvent;
}

/** Runs one SQL statement; Prisma's $executeRaw (tagged) fits. */
export type SqlExecutor = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * Publishes an event with pg_notify. Events are hints for the web app to refresh, so a failed publish is logged by
 * the caller and never fails the work that caused it.
 */
export async function publishEvent(execute: SqlExecutor, userId: string, event: AppEvent): Promise<void> {
  const payload = JSON.stringify({ userId, event } satisfies UserEvent);
  await execute`SELECT pg_notify(${EVENTS_CHANNEL}, ${payload})`;
}

export interface EventListenerOptions {
  connectionString: string;
  onEvent: (message: UserEvent) => void;
  onError?: (error: Error) => void;
  /** Delay before reconnecting after the connection drops. */
  reconnectMs?: number;
}

/** LISTENs on the events channel on its own connection, and reconnects when it drops. */
export class EventListener {
  private client: Client | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(private readonly options: EventListenerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.options.connectionString });
    client.on("notification", (message) => {
      if (message.channel !== EVENTS_CHANNEL || !message.payload) return;
      try {
        this.options.onEvent(JSON.parse(message.payload) as UserEvent);
      } catch (error) {
        this.options.onError?.(error as Error);
      }
    });
    client.on("error", (error) => {
      this.options.onError?.(error);
      this.dropped(client);
    });
    client.on("end", () => this.dropped(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
  }

  /** The live connection dropped: reconnect (connections that never went live are ignored). */
  private dropped(client: Client): void {
    if (this.client !== client) return;
    this.client = null;
    void client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect().catch((error: Error) => {
        this.options.onError?.(error);
        this.scheduleReconnect();
      });
    }, this.options.reconnectMs ?? 2000);
  }
}
