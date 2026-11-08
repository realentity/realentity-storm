import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type HealthView } from "@realentity/storm-shared";
import request from "supertest";
import { HealthChecks } from "../src/health/health-checks";
import { createTestApp, type TestApp } from "./support/test-app";

const TOKEN = "h".repeat(40);
const HOUR = 3_600_000;

// M26-I1
describe("watching the server: health reports", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let alerts: string[];

  beforeAll(async () => {
    process.env.HEALTH_REPORT_TOKEN = TOKEN;
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    api.app.get(HealthChecks).alert = (text) => (alerts.push(text), Promise.resolve());
  });

  beforeEach(() => {
    alerts = [];
  });

  afterEach(async () => {
    await db.client.healthCheck.deleteMany();
  });

  afterAll(async () => {
    delete process.env.HEALTH_REPORT_TOKEN;
    await db.close();
    await api.close();
  });

  const report = (body: Record<string, unknown>, token: string | null = TOKEN) => {
    const call = request(api.http).post("/api/hooks/health");
    return (token === null ? call : call.set("x-storm-health-token", token)).send(body);
  };
  const evaluate = (hoursLater: number) => api.app.get(HealthChecks).evaluate(new Date(Date.now() + hoursLater * HOUR));

  it("a failed backup, a stopped one and a full disk each alert once; recovery is told once", async () => {
    await report({ name: "backup", ok: true, detail: "Backup finished OK", maxAgeHours: 26 }).expect(204);
    await report({ name: "server", ok: true, detail: "/ 41%, /data 63%; no failed services", maxAgeHours: 5 }).expect(204);
    expect(alerts).toEqual([]);

    // A full disk: told once, however often it is reported.
    await report({ name: "server", ok: false, detail: "/data is 91% full; ", maxAgeHours: 5 }).expect(204);
    await report({ name: "server", ok: false, detail: "/data is 92% full; ", maxAgeHours: 5 }).expect(204);
    expect(alerts).toEqual(["⚠️ Storm: server: /data is 91% full; "]);
    await report({ name: "server", ok: true, detail: "/ 41%, /data 70%; no failed services", maxAgeHours: 5 }).expect(204);
    expect(alerts.at(-1)).toBe("✅ Storm: server is fine again: / 41%, /data 70%; no failed services");

    // A backup that failed, then one that didn't run at all.
    await report({ name: "backup", ok: false, detail: "Backup failed (exit 1): journalctl -u nightly-backup" }).expect(204);
    expect(alerts.at(-1)).toBe("⚠️ Storm: backup: Backup failed (exit 1): journalctl -u nightly-backup");
    await report({ name: "backup", ok: true, detail: "Backup finished OK" }).expect(204);
    alerts = [];
    await evaluate(27);
    await evaluate(28);
    expect(alerts).toEqual([
      expect.stringMatching(/^⚠️ Storm: backup: no report since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(expected every 26 h\)$/),
      expect.stringMatching(/^⚠️ Storm: server: no report since .* \(expected every 5 h\)$/),
    ]);

    const view = (await agent.get("/api/health/checks").expect(200)).body as HealthView;
    expect(view.checks.map((c) => [c.name, c.ok, c.problem])).toEqual([
      ["backup", true, false],
      ["server", true, false],
    ]);
    expect(view.worker.state).toBeDefined();
  });

  it("refuses a wrong or missing token like an unknown path, and a report that isn't one", async () => {
    await report({ name: "backup", ok: true }, "x".repeat(40)).expect(404);
    await report({ name: "backup", ok: true }, null).expect(404);
    await report({ name: "Backup!", ok: true }).expect(400);
    await report({ name: "backup", ok: "yes" }).expect(400);
    expect(await db.client.healthCheck.count()).toBe(0);
    await request(api.http).get("/api/health/checks").expect(401);
  });
});
