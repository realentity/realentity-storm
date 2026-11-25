import {
  CALENDAR_SCOPE,
  emptySlots,
  type BindingView,
  needMet,
  type ChecklistView,
  type ExampleNeed,
  type ServerEnv,
  type SetupView,
} from "@realentity/storm-shared";
import { Integrations } from "@realentity/storm-db";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AppsService } from "../apps/apps.service";
import { BindingsService } from "../bindings/bindings.service";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

const SERVER_NOTE = "Set on the server (.env)";

/**
 * M40: what the examples need, and what an installed one still needs: what is set up (the server's settings and the
 * user's credentials, recipes, Google), and its App's pipelines tried and switched on.
 */
@Injectable()
export class ExamplesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: AppsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    private readonly bindings: BindingsService,
    private readonly integrations: Integrations,
  ) {}

  async setup(userId: string): Promise<SetupView> {
    const [credentials, accounts, recipes, google, lastRead] = await Promise.all([
      this.prisma.client.credential.findMany({ where: { userId }, select: { name: true } }),
      this.prisma.client.emailAccount.count({ where: { userId } }),
      this.prisma.client.siteRecipe.findMany({ where: { userId }, select: { name: true }, distinct: ["name"] }),
      // M50-T8: a Google account connected, allowing the calendar.
      this.prisma.client.googleAccount.findFirst({
        where: { userId, status: "CONNECTED", scopes: { has: CALENDAR_SCOPE } },
        select: { status: true },
      }),
      // The last time mail was read: an account that is there but refused (its app password revoked) isn't set up.
      this.prisma.client.step.findFirst({
        where: { type: "email.fetch", status: { in: ["DONE", "FAILED"] }, run: { userId } },
        orderBy: { finishedAt: "desc" },
        select: { status: true, error: true },
      }),
    ]);
    const names = credentials.map((c) => c.name);
    // M50-T7: an email account in Settings.
    const configured = accounts > 0;
    const emailProblem = configured && lastRead?.status === "FAILED" ? (lastRead.error ?? "reading mail failed") : null;
    return {
      email: configured && !emailProblem,
      emailProblem,
      googleCalendar: google?.status === "CONNECTED",
      telegram: Boolean(this.env.TELEGRAM_BOT_TOKEN),
      llm: await this.integrations.configured(userId),
      credentials: names,
      recipes: recipes.map((r) => r.name),
    };
  }

  /** M40-T3: an App installed from an example: what is left; null for one that wasn't. */
  async checklist(userId: string, appId: string): Promise<ChecklistView | null> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    if (!app) throw new NotFoundException();
    const example = app.example as { id: string; needs: ExampleNeed[] } | null;
    if (!example) return null;
    const setup = await this.setup(userId);
    const items: ChecklistView["items"] = [];
    for (const need of example.needs) {
      const entities =
        need.kind === "entities" ? await this.prisma.client.dataEntity.count({ where: { appId, type: need.type!, removedAt: null } }) : 0;
      const problem = need.kind === "email" && setup.emailProblem ? { note: `The last mail read failed: ${setup.emailProblem}` } : {};
      items.push({ label: need.label, done: needMet(need, setup, entities), ...where(need, appId), ...problem });
    }
    const detail = await this.apps.get(userId, appId);
    items.push(...(await this.emptySlotItems(userId, appId, detail.pipelines)));
    for (const { pipelineId, name, enabled, runsOnItsOwn } of detail.pipelines) {
      const tried = (await this.prisma.client.run.count({ where: { pipelineVersion: { pipelineId } } })) > 0;
      items.push({ label: `Try "${name}": a dry run, which sends and saves nothing`, done: tried, link: `/pipelines/${pipelineId}` });
      // One started by a button or by hand isn't switched on: it runs when started.
      if (runsOnItsOwn) items.push({ label: `Switch "${name}" on`, done: enabled, link: `/pipelines/${pipelineId}` });
    }
    return { example: example.id, items, done: items.every((i) => i.done) };
  }

  /**
   * M50-T6: each slot not filled yet, the App's (on its page) and its pipelines' (on theirs). An App's slot its
   * pipelines don't all use says which do: only they wait for it.
   */
  private async emptySlotItems(userId: string, appId: string, pipelines: { pipelineId: string; name: string }[]): Promise<ChecklistView["items"]> {
    const slotsOf = await Promise.all(pipelines.map(async (p) => ({ ...p, views: await this.bindings.ofPipeline(userId, p.pipelineId) })));
    const items: ChecklistView["items"] = [];
    for (const slot of emptySlots(await this.bindings.ofApp(userId, appId))) {
      const users = slotsOf.filter((p) => p.views.some((v) => v.owner === "app" && v.slot === slot.slot)).map((p) => `"${p.name}"`);
      const forSome = users.length > 0 && users.length < slotsOf.length ? ` (for ${users.join(", ")})` : "";
      items.push({ label: `${slotLabel(slot)}${forSome}`, done: false, link: `/apps/${appId}#needs` });
    }
    for (const { pipelineId, views } of slotsOf) {
      for (const slot of emptySlots(views.filter((v) => v.owner === "pipeline")))
        items.push({ label: slotLabel(slot), done: false, link: `/pipelines/${pipelineId}#needs` });
    }
    return items;
  }
}

/** What a slot asks for, as a checklist says it. */
function slotLabel(slot: BindingView): string {
  const what = slot.need.label ?? slot.slot;
  return slot.need.kind === "credential" ? `Choose the credential for "${what}"` : `Set "${what}"`;
}

function where(need: ExampleNeed, appId: string): { link: string | null; note?: string } {
  switch (need.kind) {
    case "email":
      return { link: "/settings/email" };
    case "google-calendar":
      return { link: "/settings/google" };
    case "recipe":
      return { link: "/recipes" };
    case "entities":
      return { link: `/a/${appId}/${encodeURIComponent(need.type!)}` };
    case "telegram":
    case "llm":
      return { link: null, note: SERVER_NOTE };
  }
}
