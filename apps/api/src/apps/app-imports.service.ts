import { type Prisma } from "@ai-me/db";
import { checkEntity, PRICE_WATCH_COLLECTION, readAppSource, type AppImportRequest, type AppDefinition, type AppImportResult, type AppImportView } from "@ai-me/shared";
import { BILL_ENTITY, billValue, contractProblems, JOB_ENTITY, OFFER_ENTITY, offerKey, PRODUCT_ENTITY, type EntityContract } from "@ai-me/steps";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * Moving what a hand-built page kept into an App (M33): its rows become entities of the App's type, once (a moved
 * one is skipped, so pressing it again moves only what came since). The old rows stay until the old page goes.
 */
@Injectable()
export class AppImportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** What this App can take: Bills when it has a Bill type bill.save writes; Prices when it has price.watch's types. */
  async available(userId: string, app: AppDefinition): Promise<AppImportView[]> {
    const imports: AppImportView[] = [];
    if (fits(app, BILL_ENTITY)) {
      const count = await this.prisma.client.bill.count({ where: { userId } });
      if (count > 0) imports.push({ from: "bills", label: "the Bills page", count });
    }
    if (fits(app, JOB_ENTITY)) {
      const count = await this.prisma.client.jobPosting.count({ where: { userId } });
      if (count > 0) imports.push({ from: "jobs", label: "the Jobs page", count });
    }
    if (fits(app, PRODUCT_ENTITY) && fits(app, OFFER_ENTITY)) {
      const count = await this.prisma.client.watchedProduct.count({ where: { userId } });
      if (count > 0) imports.push({ from: "prices", label: "the Prices page", count });
    }
    // M33-T5: a collection data.save kept (a page's `view:`), into a type pipelines write.
    if (Object.values(app.types).some((t) => !t.mine)) {
      const collections = await this.prisma.client.dataRecord.groupBy({ by: ["collection"], where: { userId }, _count: { _all: true }, orderBy: { collection: "asc" } });
      for (const c of collections) imports.push({ from: "collection", collection: c.collection, label: `the "${c.collection}" collection`, count: c._count._all });
    }
    return imports;
  }

  async move(userId: string, appId: string, { from, collection, type }: AppImportRequest): Promise<AppImportResult> {
    const row = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = row?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: row.currentVersionId } })
      : null;
    if (!row || !version) throw new NotFoundException();
    const app = readAppSource(version.source);
    if (!(await this.available(userId, app)).some((i) => i.from === from)) {
      throw new ConflictException(`"${app.name}" can't take ${from}: it needs the types ${{ bills: "bill.save", prices: "price.watch", jobs: "the job steps", collection: "pipelines write" }[from]} work with`);
    }
    if (from === "collection") return this.moveCollection(userId, appId, app, collection!, type!);
    if (from === "jobs") return this.moveJobs(userId, appId);
    return from === "bills" ? this.moveBills(userId, appId) : this.movePrices(userId, appId);
  }

  /**
   * The Prices page's products as Products of mine (a shop line per offer, its variant after "|"), each offer's last
   * reading as an Offer, and its price history under the Offer's key. A product already here (by name) is skipped.
   */
  private async movePrices(userId: string, appId: string): Promise<AppImportResult> {
    const products = await this.prisma.client.watchedProduct.findMany({ where: { userId }, include: { offers: { orderBy: { dateCreated: "asc" } } }, orderBy: { dateCreated: "asc" } });
    const here = new Set((await this.prisma.client.dataEntity.findMany({ where: { appId, type: "Product" }, select: { key: true } })).map((e) => e.key));
    let moved = 0;
    for (const product of products) {
      if (here.has(product.name)) continue;
      here.add(product.name);
      const shops = product.offers.map((offer) => {
        const select = (offer.select ?? null) as Record<string, string> | null;
        const variant = select && Object.keys(select).length ? Object.entries(select).map(([k, v]) => `${k}: ${v}`).join(", ") : undefined;
        return { offer, variant, line: variant ? `${offer.url} | ${variant}` : offer.url, key: offerKey(product.name, offer.url, variant) };
      });
      await this.prisma.client.$transaction([
        this.prisma.client.dataEntity.create({
          data: {
            appId,
            type: "Product",
            key: product.name,
            value: { name: product.name },
            mine: {
              ...(product.targetPrice === null ? {} : { targetPrice: Number(product.targetPrice) }),
              ...(product.currency ? { currency: product.currency } : {}),
              enabled: product.enabled,
              shops: shops.map((s) => s.line),
            },
            firstSeenAt: product.dateCreated,
          },
        }),
        ...shops.map(({ offer, variant, key }) =>
          this.prisma.client.dataEntity.upsert({
            where: { appId_type_key: { appId, type: "Offer", key } },
            create: {
              appId,
              type: "Offer",
              key,
              value: {
                offer: key,
                product: product.name,
                shop: new URL(offer.url).hostname,
                url: offer.url,
                ...(variant ? { variant } : {}),
                ...(offer.lastPrice === null ? {} : { price: Number(offer.lastPrice) }),
                ...(offer.lastCurrency ? { currency: offer.lastCurrency } : {}),
                ...(offer.lastInStock === null ? {} : { inStock: offer.lastInStock }),
                ...(offer.lastTitle ? { title: offer.lastTitle } : {}),
                ...(offer.lastProblem ? { problem: offer.lastProblem } : {}),
                ...(offer.lastCheckedAt ? { checkedAt: offer.lastCheckedAt.toISOString() } : {}),
              },
              firstSeenAt: offer.dateCreated,
              lastSeenAt: offer.lastCheckedAt ?? offer.dateCreated,
            },
            update: {},
          }),
        ),
      ]);
      // Its price history, under the Offer's key (the old rows stay with the old page).
      for (const { offer, key } of shops) {
        const points = await this.prisma.client.dataPoint.findMany({ where: { userId, collection: PRICE_WATCH_COLLECTION, key: offer.watchedOfferId } });
        if (points.length) {
          await this.prisma.client.dataPoint.createMany({ data: points.map((p) => ({ userId, collection: PRICE_WATCH_COLLECTION, key, value: p.value, at: p.at })) });
        }
      }
      moved++;
    }
    return { moved, skipped: products.length - moved };
  }

  /**
   * The Jobs page's postings as Jobs, each at the stage its application (else its own status) reached, with the date
   * of each; my notes as its comments. A job already here (by url) is skipped.
   */
  private async moveJobs(userId: string, appId: string): Promise<AppImportResult> {
    const postings = await this.prisma.client.jobPosting.findMany({ where: { userId }, include: { applications: true }, orderBy: { firstSeenAt: "asc" } });
    const here = new Set(
      (await this.prisma.client.dataEntity.findMany({ where: { appId, type: "Job", key: { in: postings.map((p) => p.url) } }, select: { key: true } })).map((e) => e.key),
    );
    const moving = postings.filter((p) => !here.has(p.url));
    const POSTING_STAGE = { NEW: "new", SKIPPED: "skipped", SHORTLISTED: "shortlisted", APPLIED: "applied" } as const;
    const APPLICATION_STAGE = { PREPARED: "prepared", SUBMITTED: "applied", RESPONDED: "responded", INTERVIEW: "interview", REJECTED: "rejected" } as const;
    await this.prisma.client.dataEntity.createMany({
      data: moving.map((posting): Prisma.DataEntityCreateManyInput => {
        const application = posting.applications[0];
        const stage = application ? APPLICATION_STAGE[application.status] : POSTING_STAGE[posting.status];
        const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
        const stageDates = Object.fromEntries(
          Object.entries({
            new: iso(posting.firstSeenAt),
            ...(posting.status === "SHORTLISTED" || posting.status === "SKIPPED" ? { [POSTING_STAGE[posting.status]]: iso(posting.dateUpdated) } : {}),
            prepared: application ? iso(application.dateCreated) : undefined,
            applied: iso(application?.submittedAt),
            responded: iso(application?.respondedAt),
            interview: iso(application?.interviewAt),
            rejected: iso(application?.rejectedAt),
          }).filter(([, at]) => at !== undefined),
        );
        const value = Object.fromEntries(
          Object.entries({
            url: posting.url,
            title: posting.title,
            company: posting.company,
            location: posting.location,
            description: posting.description || null,
            score: posting.score,
            scoreReason: posting.scoreReason,
            source: posting.source,
            externalId: posting.externalId,
          }).filter(([, v]) => v !== null && v !== undefined),
        );
        return {
          appId,
          type: "Job",
          key: posting.url,
          value,
          mine: application?.notes ? { comments: application.notes } : {},
          stage,
          stageDates,
          firstSeenAt: posting.firstSeenAt,
          lastSeenAt: posting.lastSeenAt,
        };
      }),
    });
    return { moved: moving.length, skipped: postings.length - moving.length };
  }

  /**
   * A collection's rows (M33-T5) as entities of a type pipelines write: each value checked as the type says (one
   * without its key or a required field stays behind), a mark of mine on the row as the yes/no field of mine of its
   * name (Upgraded → upgraded: true). A row already here (by key) is skipped.
   */
  private async moveCollection(userId: string, appId: string, app: AppDefinition, collection: string, typeName: string): Promise<AppImportResult> {
    const type = Object.hasOwn(app.types, typeName) ? app.types[typeName] : undefined;
    if (!type || type.mine) throw new ConflictException(`"${app.name}" has no type ${typeName} pipelines write`);
    const records = await this.prisma.client.dataRecord.findMany({ where: { userId, collection }, orderBy: { firstSeenAt: "asc" } });
    const here = new Set((await this.prisma.client.dataEntity.findMany({ where: { appId, type: typeName }, select: { key: true } })).map((e) => e.key));
    const data: Prisma.DataEntityCreateManyInput[] = [];
    for (const record of records) {
      const checked = checkEntity(type, record.value as Record<string, unknown>);
      if (checked.rejected || !checked.key || here.has(checked.key)) continue;
      here.add(checked.key);
      const marks = Object.keys((record.marks ?? {}) as Record<string, string>);
      const mine = Object.fromEntries(marks.filter((m) => type.fields[m]?.mine && type.fields[m]?.type === "yesno").map((m) => [m, true]));
      data.push({
        appId,
        type: typeName,
        key: checked.key,
        value: checked.value as Prisma.InputJsonObject,
        mine,
        ...(type.stages ? { stage: type.stages.initial, stageDates: { [type.stages.initial]: record.firstSeenAt.toISOString() } } : {}),
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
        removedAt: record.removedAt,
      });
    }
    await this.prisma.client.dataEntity.createMany({ data });
    return { moved: data.length, skipped: records.length - data.length };
  }

  private async moveBills(userId: string, appId: string): Promise<AppImportResult> {
    const bills = await this.prisma.client.bill.findMany({ where: { userId }, orderBy: { dateCreated: "asc" } });
    const existing = new Set(
      (
        await this.prisma.client.dataEntity.findMany({
          where: { appId, type: "Bill", key: { in: bills.map((b) => b.billKey) } },
          select: { key: true },
        })
      ).map((e) => e.key),
    );
    const moving = bills.filter((b) => !existing.has(b.billKey));
    await this.prisma.client.dataEntity.createMany({
      data: moving.map((bill): Prisma.DataEntityCreateManyInput => {
        const dueDate = bill.dueDate?.toISOString().slice(0, 10) ?? null;
        const value = billValue(
          {
            issuer: bill.issuer,
            amount: Number(bill.amount),
            currency: bill.currency,
            dueDate,
            period: bill.period,
            reference: bill.reference,
            from: bill.from,
            subject: bill.subject,
            messageId: bill.messageId,
          },
          bill.billKey,
          bill.issuerKey,
          bill.dateCreated.toISOString().slice(0, 7),
        );
        return {
          appId,
          type: "Bill",
          key: bill.billKey,
          value,
          stage: bill.paidAt ? "paid" : "due",
          stageDates: { due: bill.dateCreated.toISOString(), ...(bill.paidAt ? { paid: bill.paidAt.toISOString() } : {}) },
          firstSeenAt: bill.dateCreated,
          lastSeenAt: bill.dateUpdated,
        };
      }),
    });
    return { moved: moving.length, skipped: bills.length - moving.length };
  }
}

/** Does the App have the type a domain step works with? */
function fits(app: AppDefinition, contract: EntityContract): boolean {
  const type = Object.hasOwn(app.types, contract.type) ? app.types[contract.type] : undefined;
  return type !== undefined && contractProblems(type, contract).length === 0;
}
