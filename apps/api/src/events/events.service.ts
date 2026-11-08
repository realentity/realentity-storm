import { EventListener, publishEvent, type UserEvent } from "@realentity/storm-queue";
import { EVENTS_PATH, SESSION_COOKIE, type AppEvent, type ServerEnv } from "@realentity/storm-shared";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { type IncomingMessage, type Server } from "node:http";
import { type Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { SessionService } from "../auth/session.service";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

/** Sessions are re-checked this often, so a socket closes soon after logout or expiry. */
const SESSION_RECHECK_MS = 60_000;
/** Pings find dead connections (sleeping laptop, dropped network). */
const HEARTBEAT_MS = 30_000;

interface Client {
  socket: WebSocket;
  userId: string;
  token: string;
  alive: boolean;
}

/**
 * Live updates for the web app (README §4: REST + WebSocket). The worker and the api publish with pg_notify; this
 * listens and forwards each event to that user's sockets at /api/events. A socket opens only with a valid session
 * cookie and a same-origin Origin, checked before the handshake completes.
 */
@Injectable()
export class EventsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Events");
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly clients = new Set<Client>();
  private readonly listener: EventListener;
  private server: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly appOrigin: string | null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) env: ServerEnv,
  ) {
    this.appOrigin = env.APP_ORIGIN ?? null;
    this.listener = new EventListener({
      connectionString: env.DATABASE_URL,
      onEvent: (message) => this.forward(message),
      onError: (error) => this.logger.warn(`Event listener: ${error.message}`),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.listener.start();
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on("upgrade", this.onUpgrade);
    this.timers = [setInterval(() => void this.recheckSessions(), SESSION_RECHECK_MS), setInterval(() => this.heartbeat(), HEARTBEAT_MS)];
  }

  async onApplicationShutdown(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.server?.off("upgrade", this.onUpgrade);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.wss.close();
    await this.listener.stop();
  }

  /** Publishes from the api (decisions, kill switch, manual runs). Never throws: an event is only a refresh hint. */
  async publish(userId: string, event: AppEvent): Promise<void> {
    await publishEvent((sql, ...values) => this.prisma.client.$executeRaw(sql, ...values), userId, event).catch((error: Error) =>
      this.logger.warn(`Event not published: ${error.message}`),
    );
  }

  /** Open sockets (tests). */
  get connections(): number {
    return this.clients.size;
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== EVENTS_PATH) return;
    void this.authenticate(request).then(
      (client) => {
        if (!client) return refuse(socket, 401, "Unauthorized");
        this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, client));
      },
      () => refuse(socket, 500, "Internal Server Error"),
    );
  };

  private async authenticate(request: IncomingMessage): Promise<Omit<Client, "socket" | "alive"> | null> {
    // Cross-site WebSocket hijacking: browsers send cookies on cross-origin handshakes, so the origin must match.
    const origin = request.headers.origin;
    if (!origin || !this.originAllowed(origin, request.headers.host)) return null;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.sessions.resolve(token) : null;
    return user && token ? { userId: user.userId, token } : null;
  }

  /** APP_ORIGIN when set (behind a proxy that may rewrite Host), else the same host as the request. */
  private originAllowed(origin: string, host: string | undefined): boolean {
    if (this.appOrigin) return originOf(origin) === this.appOrigin;
    return !!host && hostOf(origin) === host.toLowerCase();
  }

  private accept(socket: WebSocket, identity: Omit<Client, "socket" | "alive">): void {
    const client: Client = { ...identity, socket, alive: true };
    this.clients.add(client);
    socket.on("pong", () => (client.alive = true));
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => socket.terminate());
    // The socket is one-way: anything the browser sends is ignored.
  }

  private forward({ userId, event }: UserEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.userId === userId && client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
    }
  }

  /** Closes sockets whose session ended (logout, expiry). Runs on a timer. */
  async recheckSessions(): Promise<void> {
    for (const client of this.clients) {
      const user = await this.sessions.resolve(client.token).catch(() => null);
      if (!user) client.socket.close(4401, "Session ended");
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
