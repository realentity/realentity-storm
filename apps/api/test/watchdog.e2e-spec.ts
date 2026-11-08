import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { STALE_MS, WorkerWatchdog } from "../src/health/worker-watchdog";
import { createTestApp, type TestApp } from "./support/test-app";

// M5-T6
describe("worker watchdog", () => {
  let api: TestApp;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    db = createPrismaConnection();
  });

  afterAll(async () => {
    await db.client.serviceHeartbeat.deleteMany();
    await db.close();
    await api.close();
  });

  const beatAt = (at: Date) =>
    db.client.serviceHeartbeat.upsert({
      where: { service: "worker" },
      create: { service: "worker", startedAt: at, lastSeenAt: at },
      update: { lastSeenAt: at },
    });

  it("alerts once when the worker's heartbeat goes stale, and once when it is back", async () => {
    const watchdog = api.app.get(WorkerWatchdog);
    const alerts: string[] = [];
    watchdog.alert = (text) => (alerts.push(text), Promise.resolve());
    const start = Date.now();
    const at = (ms: number) => new Date(start + ms);

    // No heartbeat yet, right after the api started: unknown, no alert.
    await expect(watchdog.check(at(0))).resolves.toBe("unknown");
    // Still none after the grace period: down.
    await expect(watchdog.check(at(STALE_MS + 1000))).resolves.toBe("down");
    expect(alerts).toEqual([expect.stringContaining("it hasn't started")]);

    await beatAt(at(STALE_MS + 2000));
    await expect(watchdog.check(at(STALE_MS + 3000))).resolves.toBe("up");
    await expect(watchdog.check(at(STALE_MS + 60_000))).resolves.toBe("up");
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatch(/worker is back/);

    // Stale: one alert, not one per check.
    await expect(watchdog.check(at(2 * STALE_MS + 3000))).resolves.toBe("down");
    await expect(watchdog.check(at(2 * STALE_MS + 63_000))).resolves.toBe("down");
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toMatch(/worker is down \(last seen \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);

    const health = await api.signedIn().then((agent) => agent.get("/api/health").expect(200));
    expect(health.body).toEqual({ status: "ok", worker: "down" });
  });

  it("a failing alert never breaks the check", async () => {
    const watchdog = api.app.get(WorkerWatchdog);
    watchdog.alert = () => Promise.reject(new Error("Telegram could not be reached"));
    await beatAt(new Date());
    await expect(watchdog.check(new Date(Date.now() + 10 * STALE_MS))).resolves.toBe("down");
  });
});
