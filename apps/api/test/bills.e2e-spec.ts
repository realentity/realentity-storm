import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { type BillsView, type BillView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M23-T4: the Bills page
describe("bills", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.bill.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const month = (offset: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
  };
  const bill = (billKey: string, amount: number, data: { period?: string; dueDate?: Date; currency?: string } = {}) =>
    db.client.bill.create({
      data: {
        userId,
        issuer: billKey.split("|")[0],
        issuerKey: billKey.split("|")[0],
        billKey,
        amount,
        currency: data.currency ?? "BGN",
        period: data.period ?? null,
        dueDate: data.dueDate ?? null,
        messageId: `<${billKey}@test>`,
        from: "billing@test",
        subject: "Bill",
      },
    });

  it("by month, with totals per currency and what is unpaid; marked paid and back", async () => {
    await bill("evn|1", 84.2, { period: month(0) });
    await bill("telco|1", 30, { period: month(0) });
    await bill("telco|eur", 12.5, { period: month(0), currency: "EUR" });
    await bill("evn|0", 90, { dueDate: new Date(`${month(-1)}-20T00:00:00Z`) });
    await bill("evn|old", 70, { period: month(-13) });

    const view = (await agent.get("/api/bills").expect(200)).body as BillsView;
    expect(view.bills.map((b) => [b.issuer, b.month])).toEqual([
      ["evn", month(0)],
      ["telco", month(0)],
      ["telco", month(0)],
      ["evn", month(-1)],
    ]);
    expect(view.totals).toEqual(
      expect.arrayContaining([
        { month: month(0), currency: "BGN", amount: 114.2, unpaid: 114.2 },
        { month: month(0), currency: "EUR", amount: 12.5, unpaid: 12.5 },
        { month: month(-1), currency: "BGN", amount: 90, unpaid: 90 },
      ]),
    );

    const evn = view.bills.find((b) => b.issuer === "evn" && b.month === month(0))!;
    const paid = (await agent.put(`/api/bills/${evn.billId}/paid`).send({ paid: true }).expect(200)).body as BillView;
    expect(paid.paidAt).not.toBeNull();
    const after = (await agent.get("/api/bills").expect(200)).body as BillsView;
    expect(after.totals.find((t) => t.month === month(0) && t.currency === "BGN")).toMatchObject({ amount: 114.2, unpaid: 30 });
    expect(((await agent.put(`/api/bills/${evn.billId}/paid`).send({ paid: false }).expect(200)).body as BillView).paidAt).toBeNull();

    await agent.put(`/api/bills/${evn.billId}/paid`).send({ paid: "yes" }).expect(400);
    await agent.put("/api/bills/00000000-0000-0000-0000-000000000000/paid").send({ paid: true }).expect(404);
  });
});
