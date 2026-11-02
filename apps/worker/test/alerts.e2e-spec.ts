import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { defaultCatalog, PipelineCompiler } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { join } from "node:path";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { HistoryStep } from "../src/steps/history-step";
import { HttpFetchStep } from "../src/steps/http-steps";
import { AlertStep, MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

/** A stand-in for Open-Meteo. */
class Sources {
  temperatures = [12.1, 9.4, 9.8];
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url?.startsWith("/v1/forecast")) {
        const time = this.temperatures.map((_, i) => `2026-11-03T${String(14 + i).padStart(2, "0")}:00`);
        return json({ latitude: 42.7, longitude: 23.32, hourly_units: { temperature_2m: "°C" }, hourly: { time, temperature_2m: this.temperatures } });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

/** A template from /pipelines, its https address pointed at the local stand-in. */
const template = (file: string, host: string, port: number) =>
  readFileSync(join(__dirname, "../../../pipelines", file), "utf8").replace(`https://${host}/`, `http://${host}:${port}/`);

describe("M29: data.map and data.alert", () => {
  let db: PrismaConnection;
  let userId: string;
  let sources: Sources;
  let telegram: Counting;
  let email: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sources = new Sources();
    await sources.start();
  });

  beforeEach(() => {
    sources.temperatures = [12.1, 9.4, 9.8];
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    email = new Counting("email.send", (input) => ({ messageId: "<m@test>", accepted: [input.to] }));
    // Only loopback is reachable, and only as the hosts the templates name.
    const blocked = new BlockList();
    blocked.addSubnet("10.0.0.0", 8, "ipv4");
    const resolve = (host: string) =>
      host === "api.open-meteo.com" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([new HttpFetchStep(db.client, { blocked, resolve }), new HistoryStep(db.client), new MapStep(), new AlertStep(db.client), telegram, email]),
    );
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.dataPoint.deleteMany();
    await db.client.httpCache.deleteMany();
  });

  afterAll(async () => {
    await sources.stop();
    await db.close();
  });

  describe("M29-I1: data.alert", () => {
    let pipelineId: string;
    beforeEach(async () => {
      pipelineId = (await db.client.pipeline.create({ data: { userId, name: "Alerts" } })).pipelineId;
    });

    const context = (dryRun = false, stepKey = "cold"): StepContext => ({
      runId: "00000000-0000-4000-8000-000000000001",
      userId,
      pipelineId,
      stepId: "s",
      stepKey,
      itemIndex: null,
      dryRun,
      recordUsage: () => undefined,
      attention: NO_ATTENTION,
    });
    type Result = { crossed: { place: string; alert: { value: number; line: number } }[]; cleared: { place: string }[]; active: number; text: string; unreadable: number };
    const alert = (readings: Record<string, unknown>, options: object = { below: 10, clearAt: 12 }, dryRun = false, stepKey?: string) =>
      new AlertStep(db.client).execute(
        defaultCatalog()
          .get("data.alert")!
          .input.parse({ items: Object.entries(readings).map(([place, min]) => ({ place, min })), key: "place", value: "min", ...options }),
        context(dryRun, stepKey),
      ) as Promise<Result>;

    it("tells once when a value crosses the line, and once when it is back past clearAt", async () => {
      expect(await alert({ Sofia: 9.4, Plovdiv: 13 })).toEqual({
        crossed: [{ place: "Sofia", min: 9.4, alert: { value: 9.4, line: 10, since: expect.any(String) as unknown } }],
        cleared: [],
        active: 1,
        text: "Sofia: 9.4, below 10",
        unreadable: 0,
      });
      expect(await alert({ Sofia: 8, Plovdiv: 13 })).toMatchObject({ crossed: [], cleared: [], active: 1, text: "" });
      // Over the line but not yet at clearAt: still cold.
      expect(await alert({ Sofia: 11, Plovdiv: 9 })).toMatchObject({ crossed: [{ place: "Plovdiv" }], active: 2, text: "Plovdiv: 9, below 10" });
      expect(await alert({ Sofia: 12, Plovdiv: 9.5 })).toMatchObject({ cleared: [{ place: "Sofia" }], active: 1, text: "Sofia: back to 12" });
      expect(await alert({ Sofia: 9.9 })).toMatchObject({ crossed: [{ place: "Sofia" }], active: 2 });
    });

    it("above a line; a value that isn't a number changes nothing; each step remembers its own", async () => {
      expect(await alert({ orders: "4,5", users: 1 }, { above: 3, clearAt: 1.5 })).toMatchObject({ crossed: [{ place: "orders", alert: { value: 4.5, line: 3 } }], active: 1 });
      expect(await alert({ orders: null }, { above: 3, clearAt: 1.5 })).toMatchObject({ crossed: [], cleared: [], active: 1, unreadable: 1 });
      expect(await alert({ orders: 4.5 }, { above: 3 }, false, "other")).toMatchObject({ crossed: [{ place: "orders" }], active: 1 });
      expect(await db.client.alertState.count({ where: { pipelineId } })).toBe(2);
    });

    it("a dry run tells what it would, and remembers nothing", async () => {
      expect(await alert({ Sofia: 9 }, undefined, true)).toMatchObject({ crossed: [{ place: "Sofia" }], active: 1 });
      expect(await db.client.alertState.count()).toBe(0);
      await alert({ Sofia: 9 });
      expect(await alert({ Sofia: 13 }, undefined, true)).toMatchObject({ cleared: [{ place: "Sofia" }], active: 0 });
      expect(await db.client.alertState.count()).toBe(1);
    });
  });

  it("M29-I2: pipelines/cold-weather.yaml: one email when the next 12 hours go below 10°, one when back over 12°", async () => {
    const versionId = await createVersion(db.client, userId, template("cold-weather.yaml", "api.open-meteo.com", sources.port), new PipelineCompiler(defaultCatalog()));
    const run = async () => {
      const runId = await runner.start(versionId, { trigger: "manual" });
      return { runId, status: await runner.advance(runId) };
    };
    const proposed = async (runId: string) => (await db.client.proposal.findFirstOrThrow({ where: { runId } })).originalPayload as { subject: string; body: string };

    const cold = await run();
    expect(cold.status).toBe("WAITING_FOR_USER");
    expect(await proposed(cold.runId)).toEqual({
      to: "me@example.com",
      subject: "Weather: Sofia: 9.4, below 10",
      body: "Sofia: 9.4, below 10\n\nThe lowest in the next 12 hours: 9.4° at 15:00.",
    });

    // Still cold, then milder but not yet 12°: nothing.
    sources.temperatures = [9, 9.5];
    expect((await run()).status).toBe("DONE");
    sources.temperatures = [11, 11.5];
    const milder = await run();
    expect(milder.status).toBe("DONE");
    expect(await db.client.step.findFirstOrThrow({ where: { runId: milder.runId, stepKey: "tell" } })).toMatchObject({ status: "SKIPPED" });

    sources.temperatures = [12.5, 14];
    const back = await run();
    expect(back.status).toBe("WAITING_FOR_USER");
    expect((await proposed(back.runId)).subject).toBe("Weather: Sofia: back to 12.5");
    expect(email.calls).toHaveLength(0);
  });
});
