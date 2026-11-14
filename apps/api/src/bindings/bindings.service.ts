import { type Credential } from "@realentity/storm-db";
import { hostMatches, readAppSource, type BindingsRequest, type BindingView, type CompiledDefinition, type Need, type Needs } from "@realentity/storm-shared";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

type Owner = { pipelineId: string } | { appId: string };

/** Does a credential fit a slot: its type, and the host it is for. */
export function fits(need: Need, credential: Pick<Credential, "kind" | "allowedHosts">): boolean {
  if (need.kind !== "credential") return false;
  if (need.type && credential.kind !== need.type.toUpperCase()) return false;
  return !need.for || hostMatches(need.for, credential.allowedHosts);
}

/**
 * M50: what fills a pipeline's or an App install's slots: one of the user's credentials by id, or a text. Never by a
 * credential's name. A pipeline in an App has its own slots and its App's (shared by the App's pipelines).
 */
@Injectable()
export class BindingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A pipeline's slots, its own and its App's, with what fills them. */
  async ofPipeline(userId: string, pipelineId: string): Promise<BindingView[]> {
    const { own, app } = await this.pipelineNeeds(userId, pipelineId);
    const views = await this.views(userId, { pipelineId }, own, "pipeline");
    return app ? [...views, ...(await this.views(userId, { appId: app.appId }, app.needs, "app"))] : views;
  }

  /** An App install's slots, shared by its pipelines. */
  async ofApp(userId: string, appId: string): Promise<BindingView[]> {
    return this.views(userId, { appId }, await this.appNeeds(userId, appId), "app");
  }

  async setPipeline(userId: string, pipelineId: string, body: BindingsRequest): Promise<BindingView[]> {
    const { own } = await this.pipelineNeeds(userId, pipelineId);
    await this.set(userId, { pipelineId }, own, body);
    return this.ofPipeline(userId, pipelineId);
  }

  async setApp(userId: string, appId: string, body: BindingsRequest): Promise<BindingView[]> {
    await this.set(userId, { appId }, await this.appNeeds(userId, appId), body);
    return this.ofApp(userId, appId);
  }

  /**
   * After a save or an install: each credential slot not yet filled gets the user's one credential that fits it, when
   * exactly one does (its type, its host). Never by name; a slot two credentials fit waits for the user's choice.
   */
  async fillWhereOneFits(userId: string, owner: Owner, needs: Needs): Promise<void> {
    const slots = Object.entries(needs).filter(([, need]) => need.kind === "credential");
    if (slots.length === 0) return;
    const [credentials, bound] = await Promise.all([this.mine(userId), this.prisma.client.binding.findMany({ where: owner })]);
    for (const [slot, need] of slots) {
      if (bound.some((b) => b.slot === slot)) continue;
      const fitting = credentials.filter((c) => fits(need, c));
      if (fitting.length === 1) await this.prisma.client.binding.create({ data: { ...owner, slot, credentialId: fitting[0].credentialId } });
    }
  }

  private async set(userId: string, owner: Owner, needs: Needs, body: BindingsRequest): Promise<void> {
    const problems: { path: string; message: string }[] = [];
    for (const [slot, value] of Object.entries(body)) {
      const need = Object.hasOwn(needs, slot) ? needs[slot] : undefined;
      if (!need) {
        problems.push({ path: slot, message: "isn't one of its slots" });
        continue;
      }
      if (need.kind === "credential") {
        if (value.text !== undefined) problems.push({ path: slot, message: "takes a credential, not text" });
        if (value.credentialId) {
          const credential = await this.prisma.client.credential.findFirst({ where: { credentialId: value.credentialId, userId } });
          if (!credential) problems.push({ path: slot, message: "no such credential" });
          else if (!fits(need, credential)) problems.push({ path: slot, message: `${credential.name} doesn't fit: ${describe(need)}` });
        }
      } else if (value.credentialId !== undefined) {
        problems.push({ path: slot, message: "takes text, not a credential" });
      }
    }
    if (problems.length > 0) throw new BadRequestException({ message: "Some slots can't be set", errors: problems });
    for (const [slot, value] of Object.entries(body)) {
      const where = "pipelineId" in owner ? { pipelineId_slot: { pipelineId: owner.pipelineId, slot } } : { appId_slot: { appId: owner.appId, slot } };
      const credentialId = value.credentialId ?? null;
      const text = value.text ?? null;
      if (credentialId === null && text === null) await this.prisma.client.binding.deleteMany({ where: { ...owner, slot } });
      else await this.prisma.client.binding.upsert({ where, create: { ...owner, slot, credentialId, text }, update: { credentialId, text } });
    }
  }

  private async views(userId: string, owner: Owner, needs: Needs, kind: BindingView["owner"]): Promise<BindingView[]> {
    const [bound, credentials] = await Promise.all([
      this.prisma.client.binding.findMany({ where: owner, include: { credential: { select: { credentialId: true, name: true, userId: true } } } }),
      this.mine(userId),
    ]);
    return Object.entries(needs).map(([slot, need]) => {
      const binding = bound.find((b) => b.slot === slot);
      const credential = binding?.credential && binding.credential.userId === userId ? { credentialId: binding.credential.credentialId, name: binding.credential.name } : null;
      const fitting = credentials.filter((c) => fits(need, c)).map((c) => ({ credentialId: c.credentialId, name: c.name }));
      return { slot, need, owner: kind, credential, text: binding?.text ?? null, fits: fitting };
    });
  }

  /** The user's credentials a slot may take: not Storm's own (a site's browser session). */
  private mine(userId: string) {
    return this.prisma.client.credential.findMany({
      where: { userId, name: { not: { startsWith: "session:" } } },
      select: { credentialId: true, name: true, kind: true, allowedHosts: true },
      orderBy: { name: "asc" },
    });
  }

  /**
   * M50-T15: after an edit, a slot that is gone keeps its binding under the new slot that asks for the same (a slot
   * renamed in the YAML, or rewritten by the builder): when exactly one new, empty slot needs the same kind of thing.
   */
  async carryOver(owner: Owner, before: Needs, after: Needs): Promise<void> {
    const gone = Object.keys(before).filter((slot) => !Object.hasOwn(after, slot));
    if (gone.length === 0) return;
    const bound = await this.prisma.client.binding.findMany({ where: owner });
    for (const slot of gone) {
      const binding = bound.find((b) => b.slot === slot);
      if (!binding) continue;
      const same = Object.entries(after).filter(
        ([next, need]) => !Object.hasOwn(before, next) && !bound.some((b) => b.slot === next) && sameNeed(before[slot], need),
      );
      if (same.length === 1) {
        const [renamed] = same[0];
        await this.prisma.client.binding.update({ where: { bindingId: binding.bindingId }, data: { slot: renamed } });
        bound.splice(bound.indexOf(binding), 1, { ...binding, slot: renamed });
      }
    }
  }

  private async pipelineNeeds(userId: string, pipelineId: string): Promise<{ own: Needs; app: { appId: string; needs: Needs } | null }> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline) throw new NotFoundException();
    const version = pipeline.currentVersionId ? await this.prisma.client.pipelineVersion.findUnique({ where: { pipelineVersionId: pipeline.currentVersionId } }) : null;
    const definition = version?.definition as unknown as CompiledDefinition | undefined;
    const appId =
      definition?.refs?.appId ??
      (definition?.app ? (await this.prisma.client.app.findUnique({ where: { userId_name: { userId, name: definition.app } } }))?.appId : undefined);
    return { own: definition?.needs ?? {}, app: appId ? { appId, needs: await this.appNeeds(userId, appId) } : null };
  }

  private async appNeeds(userId: string, appId: string): Promise<Needs> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    if (!app) throw new NotFoundException();
    const version = app.currentVersionId ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } }) : null;
    return version ? (readAppSource(version.source).needs ?? {}) : {};
  }
}

/** Two slots ask for the same: the same kind, and for a credential the same type and host. */
function sameNeed(a: Need, b: Need): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "text" || (b.kind === "credential" && a.type === b.type && a.for === b.for);
}

function describe(need: Extract<Need, { kind: "credential" }>): string {
  return [need.type ? `a ${need.type.replace("_", " ")}` : "a credential", need.for ? `allowed on ${need.for}` : null].filter(Boolean).join(", ");
}
