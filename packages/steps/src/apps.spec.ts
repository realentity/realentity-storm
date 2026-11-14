import { AppDefinitionSchema, checkEntity, type AppDefinition, type CompileResult } from "@realentity/storm-shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { diffApps } from "./app-diff";
import { offerKey, parseShopLine } from "./domain-entities";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";
import { draftType } from "./draft-type";

const compiler = new PipelineCompiler(defaultCatalog());

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
  return result;
}

function errorsOf(result: CompileResult): string[] {
  if (result.ok) throw new Error("expected compile errors");
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

const jobSearch: AppDefinition = AppDefinitionSchema.parse({
  name: "Job Search",
  icon: "briefcase",
  types: {
    Job: {
      key: "url",
      title: "position",
      fields: {
        url: { type: "url", required: true },
        position: { type: "text", required: true },
        company: { type: "text" },
        salary: { type: "money", currency: "salaryCurrency" },
        salaryCurrency: { type: "text" },
        tech: { type: "list" },
        posted: { type: "date" },
        favorite: { type: "yesno", mine: true },
      },
    },
  },
});

const fetch = { id: "feed", type: "http.fetch", with: { url: "https://jobs.example.com/feed" } };
const policy = { allowedDomains: ["jobs.example.com"] };
const inApp = (steps: object[], extra: object = {}) => ({ name: "Jobs", app: "Job Search", policy, steps, ...extra });

describe("Apps (M30)", () => {
  describe("an App's definition", () => {
    it("fills in its defaults", () => {
      expect(jobSearch.types.Job?.fields.url).toEqual({ type: "url", required: true, mine: false });
      expect(jobSearch.icon).toBe("briefcase");
    });

    it("refuses a key, title, enum, currency or field of mine that can't work", () => {
      const result = AppDefinitionSchema.safeParse({
        name: "Bad",
        types: {
          job: { key: "url", fields: { url: { type: "url" } } },
          Job: {
            key: "missing",
            title: "nope",
            fields: {
              status: { type: "enum" },
              kind: { type: "text", values: ["a"] },
              salary: { type: "money", currency: "posted" },
              posted: { type: "date" },
              note: { type: "text", mine: true, required: true },
              company: { type: "text" },
              "company.name": { type: "text" },
            },
          },
          Flag: { key: "done", fields: { done: { type: "yesno" } } },
        },
      });
      expect(result.success).toBe(false);
      const messages = result.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining("types.job"),
          'types.Job.key: "missing" is not one of the fields',
          'types.Job.title: "nope" is not one of the fields',
          "types.Job.fields.status.values: an enum needs its values",
          "types.Job.fields.kind.values: only an enum has values",
          'types.Job.fields.salary.currency: "posted" is not a text field of this type',
          'types.Job.fields.company: "company" can\'t be a field and hold fields too',
          "types.Flag.key: a key is text, a url, an email or a number, not yesno",
        ]),
      );
    });

    // M47: a Monitor's address is mine and required: its type is added by hand, so the form asks for it
    it("takes a required field of mine only on a type added by hand", () => {
      const app = (add: boolean) =>
        AppDefinitionSchema.safeParse({
          name: "Ops",
          types: { Monitor: { key: "name", fields: { name: { type: "text", required: true }, address: { type: "text", mine: true, required: true } } } },
          pages: [{ list: "Monitor", add }],
        });
      expect(app(true).success).toBe(true);
      expect(app(false).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
        "types.Monitor.fields.address.required: a field of mine can't be required unless its type is added by hand (add: true on its list): pipelines write the entity first",
      ]);
    });
  });

  describe("checking an entity", () => {
    const job = jobSearch.types.Job;

    it("reads each field as its kind and keeps what the type doesn't name", () => {
      const checked = checkEntity(job, {
        url: "https://jobs.example.com/1",
        position: " Backend developer ",
        salary: "4 500",
        posted: "2026-11-03T09:00:00Z",
        tech: ["node"],
        remote: true,
      });
      expect(checked).toEqual({
        key: "https://jobs.example.com/1",
        value: {
          url: "https://jobs.example.com/1",
          position: "Backend developer",
          salary: 4500,
          posted: "2026-11-03",
          tech: ["node"],
          remote: true,
        },
        problems: [],
        rejected: false,
      });
    });

    it("leaves out a wrong field, never takes a field of mine, and rejects a missing required one", () => {
      expect(checkEntity(job, { url: "https://jobs.example.com/2", position: "QA", salary: "a lot", favorite: true })).toEqual({
        key: "https://jobs.example.com/2",
        value: { url: "https://jobs.example.com/2", position: "QA" },
        problems: ["salary isn't a number", "favorite is mine: a pipeline can't set it"],
        rejected: false,
      });
      expect(checkEntity(job, { url: "javascript:alert(1)", position: "QA" })).toMatchObject({
        key: null,
        problems: ["url isn't an http(s) address"],
        rejected: true,
      });
      expect(checkEntity(job, { url: "https://jobs.example.com/3" })).toMatchObject({ problems: ["position is missing"], rejected: true });
    });
  });

  describe("pipelines in an App", () => {
    it("types data.save and data.read by the App's types", () => {
      const compiled = ok(
        compiler.compile(
          inApp([
            fetch,
            { id: "save", type: "data.save", with: { items: "{{feed.items}}", type: "Job", fields: ["salary"] } },
            {
              id: "best",
              type: "data.read",
              with: { type: "Job", where: [{ field: "favorite", op: "eq", value: true }], sort: "-salary", limit: 5 },
            },
            {
              id: "tell",
              type: "notify.telegram",
              forEach: "{{best.items}}",
              with: { text: "{{item.position}} at {{item.company}}: {{item.salary}}" },
            },
          ]),
          { app: jobSearch },
        ),
      );
      expect(compiled.definition.app).toBe("Job Search");
    });

    it("refuses an unknown App, type or field, and a pipeline outside any App", () => {
      expect(errorsOf(compiler.compile(inApp([{ id: "read", type: "data.read", with: { type: "Job" } }])))).toEqual([
        'app: there is no App named "Job Search"',
      ]);
      expect(
        errorsOf(
          compiler.compile(
            inApp([
              { id: "read", type: "data.read", with: { type: "Jobs", sort: "-salery" } },
              {
                id: "best",
                type: "data.read",
                with: { type: "Job", where: [{ field: "salery", op: "gt", value: 1 }], sort: "-@firstSeen" },
              },
              { id: "tell", type: "notify.telegram", forEach: "{{best.items}}", with: { text: "{{item.salery}}" } },
            ]),
            { app: jobSearch },
          ),
        ),
      ).toEqual([
        'steps[0].with.type: "Job Search" has no type "Jobs" (types: Job)',
        'steps[1].with.where[0].field: Job has no field "salery" (fields: url, position, company, salary, salaryCurrency, tech, posted, favorite)',
        'steps[2].with.text: {{item.salery}}: the item has no field "salery" (fields: url, position, company, salary, salaryCurrency, tech, posted, favorite)',
      ]);
      expect(errorsOf(compiler.compile({ name: "Loose", steps: [{ id: "read", type: "data.read", with: { type: "Job" } }] }))).toEqual([
        "steps[0].with.type: entity types belong to an App: say which with `app:` at the top of the pipeline",
      ]);
    });

    it("M30-S1: names fields as they are, never through a reference", () => {
      expect(
        errorsOf(
          compiler.compile(
            inApp([
              fetch,
              {
                id: "read",
                type: "data.read",
                with: { type: "Job", where: [{ field: "{{feed.text}}", op: "eq", value: "{{feed.text}}" }], sort: "{{feed.text}}" },
              },
            ]),
            { app: jobSearch },
          ),
        ),
      ).toEqual([
        "steps[1].with.where[0].field: names a field of the type as it is, not through a reference",
        "steps[1].with.sort: names a field of the type as it is, not through a reference",
      ]);
    });

    it("never lets a pipeline write a field of mine, or pick the key", () => {
      expect(
        errorsOf(
          compiler.compile(
            inApp([
              { id: "read", type: "data.read", with: { type: "Job" } },
              { id: "save", type: "data.save", with: { items: "{{read.items}}", type: "Job", key: "position", collection: "jobs" } },
            ]),
            { app: jobSearch },
          ),
        ),
      ).toEqual([
        "steps[1].with.collection: saves into a type or a collection, not both",
        "steps[1].with.key: Job's key (url) identifies its entities",
        "steps[1].with.items: Job.favorite is mine: a pipeline can't write it",
      ]);
    });

    it("types entity.changed by its type, and never takes a target from it", () => {
      const trigger = { on: "entity.changed", type: "Job", field: "salary" };
      ok(
        compiler.compile(
          inApp(
            [
              {
                id: "tell",
                type: "notify.telegram",
                with: { text: "{{trigger.item.position}}: {{trigger.before.salary}} → {{trigger.item.salary}}" },
              },
            ],
            { trigger },
          ),
          { app: jobSearch },
        ),
      );
      expect(
        errorsOf(
          compiler.compile(
            inApp(
              [
                { id: "tell", type: "notify.telegram", with: { text: "{{trigger.item.salery}}" } },
                { id: "mail", type: "email.send", with: { to: "{{trigger.item.company}}", subject: "Hi", body: "Hello" } },
              ],
              { trigger: { on: "entity.changed", type: "Job", field: "salery" } },
            ),
            { app: jobSearch },
          ),
        ),
      ).toEqual([
        'trigger.field: Job has no field "salery" (fields: url, position, company, salary, salaryCurrency, tech, posted, favorite)',
        'steps[0].with.text: {{trigger.item.salery}}: "item" has no field "salery" (fields: url, position, company, salary, salaryCurrency, tech, posted, favorite)',
        "steps[1].with.to: {{trigger.item.company}} can't be a target: an entity holds what a pipeline read from pages, feeds or emails (only a type of mine can be)",
      ]);
      expect(
        errorsOf(compiler.compile({ name: "Loose", trigger, steps: [{ id: "tell", type: "notify.telegram", with: { text: "hi" } }] })),
      ).toEqual(["trigger.type: entity.changed is about a type of the pipeline's App: say which with `app:`"]);
    });
  });

  // M33: a step that writes entities of its own needs its App to have their type
  it("checks bill.save's Bill against the pipeline's App", () => {
    const bills = AppDefinitionSchema.parse(parseYaml(readFileSync(join(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8")));
    const save = (app?: object) => ({ name: "Bills", ...(app ? { app: "Bills" } : {}), steps: [{ id: "save", type: "bill.save", with: { bills: [] } }] });
    ok(compiler.compile(save({}), { app: bills }));
    expect(errorsOf(compiler.compile(save()))).toEqual(["steps[0].type: bill.save writes Bill entities: say which App with `app:` (one with a Bill type)"]);
    const bill = bills.types.Bill;
    const changed = AppDefinitionSchema.parse({
      ...bills,
      pages: [],
      types: {
        Bill: {
          ...bill,
          key: "issuer",
          stages: { ...bill.stages, states: ["due", "settled"], moves: [{ from: "due", to: ["settled"] }] },
          fields: { ...Object.fromEntries(Object.entries(bill.fields).filter(([n]) => n !== "status" && n !== "subject")), amount: { type: "number", required: true } },
        },
      },
    });
    expect(errorsOf(compiler.compile(save({}), { app: changed }))).toEqual([
      'steps[0].type: bill.save writes Bill entities: its key must be billKey; amount must be money, not number; subject (text) is missing; its stages need the state "paid"',
    ]);
  });

  // M33: price.watch reads Products of mine and writes Offers
  it("checks price.watch's Product and Offer, and reads a shop line", () => {
    const prices = AppDefinitionSchema.parse(parseYaml(readFileSync(join(__dirname, "../../../pipelines/apps/prices.yaml"), "utf8")));
    const watch = { name: "Prices", app: "Prices", steps: [{ id: "watch", type: "price.watch", with: {} }] };
    ok(compiler.compile(watch, { app: prices }));
    const notMine = AppDefinitionSchema.parse({ ...prices, pages: [], types: { ...prices.types, Product: { ...prices.types.Product, mine: false } } });
    expect(errorsOf(compiler.compile(watch, { app: notMine }))).toEqual(["steps[0].type: price.watch reads Product entities: it must be a type of mine (mine: true)"]);
    const noOffer = AppDefinitionSchema.parse({ ...prices, pages: [], types: { Product: prices.types.Product } });
    expect(errorsOf(compiler.compile(watch, { app: noOffer }))).toEqual(['steps[0].type: price.watch writes Offer entities, and "Prices" has no type Offer']);

    expect(parseShopLine("https://shop.test/p/7")).toEqual({ url: "https://shop.test/p/7" });
    expect(parseShopLine(" https://shop.test/p/7 | size: M ,color:Black ")).toEqual({
      url: "https://shop.test/p/7",
      select: { size: "M", color: "Black" },
      variant: "size: M, color: Black",
    });
    expect(parseShopLine("javascript:alert(1)")).toBeNull();
    expect(parseShopLine("https://shop.test | size")).toBeNull();
    expect(offerKey("Jacket", "https://shop.test/p/7", "size: M")).toBe("Jacket | https://shop.test/p/7 | size: M");
  });

  describe("a draft type from samples (M30-U2)", () => {
    it("an API's JSON: kinds from values, nested objects as dotted fields, money from amount and currency", () => {
      const items = [1, 2, 3].map((n) => ({
        id: `job-${n}`,
        title: `Developer ${n}`,
        url: `https://jobs.example.com/${n}`,
        posted: `2026-11-0${n}`,
        updated: `2026-11-0${n}T10:00:00Z`,
        remote: n % 2 === 0,
        company: { name: `Acme ${n}`, site: "https://acme.example.com" },
        salary: { amount: 4000 + n, currency: "EUR" },
        tags: ["node"],
        ...(n === 1 ? { note: "first" } : {}),
      }));
      expect(draftType(items)).toEqual({
        mine: false,
        key: "id",
        title: "title",
        fields: {
          id: { type: "text", required: true, mine: false },
          title: { type: "text", required: true, mine: false },
          url: { type: "url", required: true, mine: false },
          posted: { type: "date", required: true, mine: false },
          updated: { type: "datetime", required: true, mine: false },
          remote: { type: "yesno", required: true, mine: false },
          "company.name": { type: "text", required: true, mine: false },
          "company.site": { type: "url", required: true, mine: false },
          "salary.amount": { type: "money", required: true, mine: false, currency: "salary.currency" },
          "salary.currency": { type: "text", required: true, mine: false },
          tags: { type: "list", required: true, mine: false },
          note: { type: "text", required: false, mine: false },
        },
      });
    });

    it("a page's schema.org data and an email's items: the url as key, few repeated values as an enum, mixed values as text", () => {
      const offers = Array.from({ length: 10 }, (_, n) => ({
        url: `https://shop.example.com/p/${n}`,
        name: `Disk ${n}`,
        availability: n % 3 === 0 ? "OutOfStock" : "InStock",
        price: n % 2 ? 100 + n : `${100 + n}`,
        sku: n % 2 ? n : `sku-${n}`,
        description: "A disk.\nFast.",
        from: `shop${n}@example.com`,
      }));
      expect(draftType(offers)).toEqual({
        mine: false,
        key: "url",
        title: "name",
        fields: {
          url: { type: "url", required: true, mine: false },
          name: { type: "text", required: true, mine: false },
          availability: { type: "enum", values: ["InStock", "OutOfStock"], required: true, mine: false },
          price: { type: "number", required: true, mine: false },
          sku: { type: "text", required: true, mine: false },
          description: { type: "longtext", required: true, mine: false },
          from: { type: "email", required: true, mine: false },
        },
      });
    });

    it("drafts nothing without items or without a field that tells them apart", () => {
      expect(draftType([])).toBeNull();
      expect(draftType([{ kind: "a" }, { kind: "a" }])).toBeNull();
    });
  });

  it("says what changed between two versions", () => {
    const next = AppDefinitionSchema.parse({
      ...jobSearch,
      icon: "star",
      types: {
        Job: {
          ...jobSearch.types.Job,
          fields: {
            ...Object.fromEntries(Object.entries(jobSearch.types.Job.fields).filter(([name]) => name !== "tech")),
            salary: { type: "number" },
            rating: { type: "number", mine: true },
          },
        },
        Company: { key: "name", fields: { name: { type: "text", required: true } } },
      },
    });
    expect(diffApps(jobSearch, next)).toEqual([
      "icon: briefcase → star",
      "Job.tech removed",
      "Job.salary: money → number",
      "Job.rating added (number mine)",
      "type Company added (1 fields)",
    ]);
  });
});
