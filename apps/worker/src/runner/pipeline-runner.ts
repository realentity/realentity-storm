import { payloadHash } from "@realentity/storm-crypto";
import { addUsage, type LlmUsage } from "@realentity/storm-llm";
import { type Prisma, type PrismaClient, type Proposal, type RunStatus, type Step } from "@realentity/storm-db";
import {
  canonicalJson,
  type AppEvent,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompiledStep,
  type ProposalStatusName,
} from "@realentity/storm-shared";
import { type EventJob } from "@realentity/storm-queue";
import { referencesIn, type StepCatalog, type StepDefinition } from "@realentity/storm-steps";
import { Logger } from "@nestjs/common";
import { PolicyGuard, PolicyViolation, type TargetCheck } from "./policy-guard";
import { RunControls, type ControlledRun } from "./run-controls";
import { RunValues, sourceOf, type ItemScope } from "./run-values";
import { NO_ATTENTION, RunStopped, type ExecutorRegistry, type StepContext } from "./step-executor";
import { type TakeoverDesk } from "./takeovers";

/** Where the runner reports progress (the web app's live updates). Must not throw; a lost event only delays a refresh. */
export type EventSink = (userId: string, event: AppEvent) => Promise<void>;

const noEvents: EventSink = () => Promise.resolve();

/** Where the runner sends what may start other pipelines (M12-T1): the events queue. */
export type TriggerEvents = (event: EventJob) => Promise<void>;

export interface StartOptions {
  trigger: "schedule" | "manual" | "event" | "webhook" | "telegram" | "dry-run";
  dryRun?: boolean;
  /** M37-T3: a dry run stops after this step. */
  stopAfter?: string;
  /** {{trigger.*}} (M12). */
  triggerData?: Record<string, unknown>;
  /** Started by an event of this run, at this depth of the chain. */
  triggeredByRunId?: string;
  chainDepth?: number;
}

type StepResult =
  | { kind: "done"; output: unknown }
  | { kind: "skipped" }
  | { kind: "waiting" }
  | { kind: "failed" }
  /** Over a rate limit: the run continues at `until`. */
  | { kind: "deferred"; until: Date }
  /** Kill switch or budget: the run stops before this step. */
  | { kind: "stopped"; reason: string };

/** Where a run stands after an advance. */
interface Outcome {
  status: RunStatus;
  summary?: string;
  resumeAt?: Date;
}

interface RunState {
  runId: string;
  userId: string;
  dryRun: boolean;
  /** M37-T3: a dry run tried up to this step; the steps after it don't run. */
  stopAfter: string | null;
  chainDepth: number;
  controlled: ControlledRun;
  definition: CompiledDefinition;
  policy: CompiledPolicy;
  rows: Map<string, Step>;
  proposals: Proposal[];
  values: RunValues;
  /** forEach source → item indexes rejected at a gate (their later steps are skipped). */
  rejected: Map<string, Set<number>>;
  /** forEach source → item indexes waiting at a gate. */
  blocked: Map<string, Set<number>>;
  /** Non-forEach side-effect steps whose gate was rejected. */
  rejectedSingles: Set<string>;
  /** Steps skipped by `when` (M13), or because they use one: later steps that use them are skipped too. */
  skippedSteps: Set<string>;
  /** The `when` paths that were empty, for a quiet run's summary. */
  emptyWhens: Set<string>;
}

const key = (stepKey: string, itemIndex: number | null): string => `${stepKey}#${itemIndex ?? ""}`;

/** What `when` treats as nothing: no value, false, 0, empty text, an empty list or object. */
/**
 * What the text of a side effect drew on (M42-T3, docs/design.md §8.1): the topic facts the draft steps its payload
 * refers to say they used (their `drewOn`), for the gate's "Why". Null when none did.
 */
function drewOn(state: RunState, values: unknown, scope: ItemScope | undefined): string | null {
  const steps = [...new Set(referencesIn(values).map((path) => path.split(".")[0] ?? ""))].filter(
    (id) => id && id !== "item" && id !== "trigger",
  );
  const lines = steps.flatMap((id) => {
    try {
      const used = state.values.lookup(`${id}.drewOn`, scope);
      return Array.isArray(used) ? used.filter((line): line is string => typeof line === "string") : [];
    } catch {
      return [];
    }
  });
  return lines.length ? `Drew on what Storm knows about the topic:\n${lines.map((line) => `• ${line}`).join("\n")}` : null;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Interprets a PipelineVersion step by step (docs/design.md §2.6). All progress is in Step rows, so a run resumes from the
 * last completed step after a restart; nothing that finished runs again, and side-effect steps never run twice.
 * Gates create proposals and pause the run; a side-effect step executes only the approved, hash-checked payload.
 */
export class PipelineRunner {
  private readonly logger = new Logger(PipelineRunner.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: StepCatalog,
    private readonly executors: ExecutorRegistry,
    private readonly controls: RunControls = new RunControls(prisma),
    private readonly events: EventSink = noEvents,
    /** Headed steps pausing for the user; without it, a step that needs the user fails. */
    private readonly takeovers?: TakeoverDesk,
    /** Events for event-triggered pipelines; without it, nothing triggers on what runs do. */
    private readonly triggers?: TriggerEvents,
  ) {}

  async start(pipelineVersionId: string, options: StartOptions): Promise<string> {
    const version = await this.prisma.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId }, include: { pipeline: true } });
    const definition = version.definition as unknown as CompiledDefinition;
    const run = await this.prisma.run.create({
      data: {
        userId: version.pipeline.userId,
        pipelineVersionId,
        trigger: options.trigger,
        dryRun: options.dryRun ?? false,
        ...(options.dryRun && options.stopAfter ? { stopAfter: options.stopAfter } : {}),
        ...(options.triggerData ? { triggerData: options.triggerData as Prisma.InputJsonValue } : {}),
        chainDepth: options.chainDepth ?? 0,
        triggeredByRunId: options.triggeredByRunId ?? null,
        headed: this.catalog.needsHeaded(definition.steps),
        status: "QUEUED",
      },
    });
    await this.emit(run.userId, { type: "run", runId: run.runId, pipelineId: version.pipelineId, status: "QUEUED" });
    return run.runId;
  }

  /**
   * Runs as far as possible: until done, failed, stopped, held back by a rate limit (QUEUED, with `resumeAt`), or
   * waiting for the user. Returns the run's status afterwards.
   */
  async advance(runId: string): Promise<RunStatus> {
    for (;;) {
      // Claim the run, so two workers (or a retried job) never advance it at the same time. A run waiting in the
      // live view is still being advanced (its step holds the page): not claimable.
      const claimed = await this.prisma.run.updateMany({
        where: { runId, status: { in: ["QUEUED", "WAITING_FOR_USER"] }, takeovers: { none: { status: { in: ["OPEN", "TAKEN_OVER"] } } } },
        data: { status: "RUNNING", resumeAt: null },
      });
      if (claimed.count === 0) return (await this.prisma.run.findUniqueOrThrow({ where: { runId } })).status;
      const owner = await this.prisma.run.findUniqueOrThrow({
        where: { runId },
        select: { userId: true, pipelineVersion: { select: { pipelineId: true } } },
      });
      const runEvent = (status: RunStatus) =>
        this.emit(owner.userId, { type: "run", runId, pipelineId: owner.pipelineVersion.pipelineId, status });
      await runEvent("RUNNING");

      const outcome = await this.executeSafely(runId);
      const finished = outcome.status === "DONE" || outcome.status === "FAILED" || outcome.status === "ABORTED";
      await this.prisma.run.update({
        where: { runId },
        data: {
          status: outcome.status,
          finishedAt: finished ? new Date() : null,
          resumeAt: outcome.resumeAt ?? null,
          ...(outcome.summary ? { summary: outcome.summary } : {}),
        },
      });
      if (outcome.status === "ABORTED") await this.expireOpenProposals(runId);
      await runEvent(outcome.status);
      if (outcome.status === "DONE" || outcome.status === "FAILED") await this.finished(runId, outcome.status);
      // A decision made during this advance isn't in its state, and the job sent for it found the run claimed.
      // The status is saved first, so either that job claims the run now, or this check sees the decision.
      if (outcome.status !== "WAITING_FOR_USER" || !(await this.hasUnreadDecision(runId))) return outcome.status;
    }
  }

  /**
   * After a restart: runs left RUNNING were interrupted. Their interrupted steps re-run on the next advance, except
   * side-effect steps, which fail (the action may or may not have happened; the user decides). Returns the runs to advance.
   */
  async recoverInterrupted(): Promise<string[]> {
    const runs = await this.prisma.run.findMany({
      where: { status: "RUNNING" },
      include: { pipelineVersion: true, steps: { where: { status: "RUNNING" } } },
    });
    const resumable: string[] = [];
    for (const run of runs) {
      const definition = run.pipelineVersion.definition as unknown as CompiledDefinition;
      let failed = false;
      for (const step of run.steps) {
        const compiled = definition.steps.find((s) => s.id === step.stepKey);
        const sideEffect = compiled ? this.catalog.get(compiled.type)?.sideEffect : false;
        if (sideEffect) {
          await this.prisma.step.update({
            where: { stepId: step.stepId },
            data: { status: "FAILED", error: "Interrupted while acting; check the target before retrying", finishedAt: new Date() },
          });
          failed = true;
        } else {
          await this.prisma.step.update({ where: { stepId: step.stepId }, data: { status: "PENDING" } });
        }
      }
      await this.prisma.run.update({
        where: { runId: run.runId },
        data: failed
          ? { status: "FAILED", finishedAt: new Date(), summary: "Interrupted during a side-effect step" }
          : { status: "QUEUED" },
      });
      if (!failed) resumable.push(run.runId);
    }
    return resumable;
  }

  private async executeSafely(runId: string): Promise<Outcome> {
    try {
      return await this.execute(await this.load(runId));
    } catch (error) {
      return { status: "FAILED", summary: `Runner error: ${message(error)}` };
    }
  }

  /** run.finished (M12-T1): the run's step outputs for the pipelines triggered by it. Dry runs trigger nothing. */
  private async finished(runId: string, status: "DONE" | "FAILED"): Promise<void> {
    if (!this.triggers) return;
    const run = await this.prisma.run.findUniqueOrThrow({
      where: { runId },
      include: { pipelineVersion: { include: { pipeline: true } }, steps: { orderBy: [{ itemIndex: "asc" }] } },
    });
    if (run.dryRun) return;
    const outputs: Record<string, unknown> = {};
    for (const step of run.steps) {
      if (step.itemIndex === null) outputs[step.stepKey] = step.output ?? null;
      else ((outputs[step.stepKey] ??= []) as unknown[])[step.itemIndex] = step.output ?? null;
    }
    const pipeline = run.pipelineVersion.pipeline;
    await this.triggers({
      userId: run.userId,
      event: "run.finished",
      data: { runId, pipeline: pipeline.name, status, summary: run.summary, outputs },
      source: { runId, pipelineId: pipeline.pipelineId, depth: run.chainDepth },
    }).catch((error: Error) => this.logger.warn(`run.finished of ${runId} not sent: ${error.message}`));
  }

  private async hasUnreadDecision(runId: string): Promise<boolean> {
    const decided = await this.prisma.proposal.count({
      where: { runId, status: { in: ["APPROVED", "REJECTED"] }, step: { status: "WAITING" } },
    });
    return decided > 0;
  }

  /** A stopped run's proposals can no longer be acted on. */
  private async expireOpenProposals(runId: string): Promise<void> {
    await this.prisma.proposal.updateMany({
      where: { runId, status: { in: ["PENDING_REVIEW", "APPROVED"] } },
      data: { status: "EXPIRED" },
    });
  }

  private async load(runId: string): Promise<RunState> {
    const run = await this.prisma.run.findUniqueOrThrow({
      where: { runId },
      include: { pipelineVersion: { include: { pipeline: true } }, steps: true, proposals: true },
    });
    const definition = run.pipelineVersion.definition as unknown as CompiledDefinition;
    return {
      runId,
      userId: run.userId,
      dryRun: run.dryRun,
      stopAfter: run.dryRun ? run.stopAfter : null,
      chainDepth: run.chainDepth,
      controlled: {
        userId: run.userId,
        pipelineId: run.pipelineVersion.pipelineId,
        essential: run.pipelineVersion.pipeline.essential,
        limits: definition.limits,
      },
      definition,
      policy: run.pipelineVersion.policy as unknown as CompiledPolicy,
      rows: new Map(run.steps.map((s) => [key(s.stepKey, s.itemIndex), s])),
      proposals: run.proposals,
      values: new RunValues(run.triggerData),
      rejected: new Map(),
      blocked: new Map(),
      rejectedSingles: new Set(),
      skippedSteps: new Set(),
      emptyWhens: new Set(),
    };
  }

  private async execute(state: RunState): Promise<Outcome> {
    const last = state.stopAfter ? state.definition.steps.findIndex((s) => s.id === state.stopAfter) : -1;
    for (const [index, step] of state.definition.steps.entries()) {
      if (last >= 0 && index > last) break;
      const definition = this.catalog.get(step.type);
      if (!definition) throw new Error(`Step type ${step.type} is not in the catalog`);

      if (!step.forEach) {
        // A single step needs everything before it settled, including every item of earlier forEach steps.
        if ([...state.blocked.values()].some((items) => items.size > 0)) return { status: "WAITING_FOR_USER" };
        if (state.rejectedSingles.has(step.id)) {
          await this.skip(state, step, null, "Rejected at the gate");
          state.values.set(step, undefined);
          continue;
        }
        const notNow = this.skipReason(state, step, undefined);
        if (notNow) {
          await this.skip(state, step, null, notNow);
          state.values.set(step, undefined);
          state.skippedSteps.add(step.id);
          continue;
        }
        const result = await this.runOne(state, step, definition, undefined);
        const interrupted = interruption(result, step);
        if (interrupted) return interrupted;
        if (result.kind === "waiting") return { status: "WAITING_FOR_USER" };
        state.values.set(step, result.kind === "done" ? result.output : undefined);
        continue;
      }

      const source = sourceOf(step.forEach);
      const unused = this.usesSkipped(state, step);
      if (unused) {
        await this.skip(state, step, null, unused);
        state.values.set(step, []);
        state.skippedSteps.add(step.id);
        continue;
      }
      const items = state.values.lookup(source);
      if (!Array.isArray(items)) throw new Error(`forEach {{${source}}} of step ${step.id} is not a list`);
      const rejected = setOf(state.rejected, source);
      const blocked = setOf(state.blocked, source);
      const outputs: unknown[] = new Array<unknown>(items.length).fill(undefined);
      for (const [index, item] of items.entries()) {
        if (rejected.has(index)) {
          await this.skip(state, step, index, "Rejected at the gate");
          continue;
        }
        if (blocked.has(index)) continue;
        const notNow = this.skipReason(state, step, { source, index, item });
        if (notNow) {
          await this.skip(state, step, index, notNow);
          continue;
        }
        const result = await this.runOne(state, step, definition, { source, index, item });
        const interrupted = interruption(result, step);
        if (interrupted) return interrupted;
        if (result.kind === "waiting") blocked.add(index);
        if (result.kind === "done") outputs[index] = result.output;
      }
      state.values.set(step, outputs);
    }
    if ([...state.blocked.values()].some((items) => items.size > 0)) return { status: "WAITING_FOR_USER" };
    if (last >= 0 && last < state.definition.steps.length - 1) {
      // The steps the user wrote: not the gates the compiler put before side effects.
      const after = state.definition.steps
        .slice(last + 1)
        .filter((s) => !s.type.startsWith("gate."))
        .map((s) => s.id);
      return { status: "DONE", summary: `Tried up to ${state.stopAfter}: ${after.join(", ")} didn't run.` };
    }
    return { status: "DONE", ...(state.emptyWhens.size ? { summary: this.quietSummary(state) } : {}) };
  }

  /**
   * A run with steps skipped by `when` says why, and what it read (catalog `reports`): "Done, nothing to tell:
   * cheaper.items was empty, so lines and tell were skipped." + "Jacket (M, Black): 343.16 EUR, in stock". "Nothing to
   * tell" only when no message or side effect ran.
   */
  private quietSummary(state: RunState): string {
    const list = (values: string[]) => (values.length > 1 ? `${values.slice(0, -1).join(", ")} and ${values.at(-1)!}` : values[0]);
    const whens = [...state.emptyWhens];
    const skipped = [...state.skippedSteps];
    const told = state.definition.steps.some(
      (step) => (step.type.startsWith("notify.") || this.catalog.get(step.type)?.sideEffect) && !state.skippedSteps.has(step.id),
    );
    const reports = state.definition.steps.flatMap((step) => {
      const field = this.catalog.get(step.type)?.reports;
      const value = field && !step.forEach ? state.values.lookup(`${step.id}.${field}`) : undefined;
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    });
    return (
      `${told ? "Done." : "Done, nothing to tell:"} ${list(whens)} ${whens.length > 1 ? "were" : "was"} empty` +
      (skipped.length ? `, so ${list(skipped)} ${skipped.length > 1 ? "were" : "was"} skipped.` : ", so some items were skipped.") +
      (state.dryRun ? " A dry run saves nothing, so each one starts from scratch." : "") +
      (reports.length ? `\n${reports.join("\n")}` : "")
    );
  }

  /** Why a step (or one item of it) doesn't run now: it uses a skipped step, or its `when` is empty (M13). */
  private skipReason(state: RunState, step: CompiledStep, scope: ItemScope | undefined): string | null {
    const unused = this.usesSkipped(state, step);
    if (unused) return unused;
    if (!step.when) return null;
    const path = sourceOf(step.when);
    if (!isEmpty(state.values.lookup(path, scope))) return null;
    state.emptyWhens.add(path);
    return `Skipped: {{${path}}} is empty`;
  }

  private usesSkipped(state: RunState, step: CompiledStep): string | null {
    const roots = [step.with, step.forEach ?? "", step.when ?? ""]
      .flatMap((value) => referencesIn(value))
      .map((path) => path.split(".")[0] ?? "");
    const skipped = roots.find((root) => state.skippedSteps.has(root));
    return skipped ? `Skipped: it uses ${skipped}, which was skipped` : null;
  }

  private async runOne(state: RunState, step: CompiledStep, definition: StepDefinition, scope: ItemScope | undefined): Promise<StepResult> {
    const itemIndex = scope?.index ?? null;
    const row = state.rows.get(key(step.id, itemIndex));
    if (row?.status === "DONE") return { kind: "done", output: row.output };
    if (row?.status === "SKIPPED") return { kind: "skipped" };
    if (row?.status === "FAILED") return { kind: "failed" };

    // Step boundary: the kill switch and the budget apply to runs already in progress.
    const reason = await this.controls.stopReason(state.controlled, definition);
    if (reason) return { kind: "stopped", reason };

    if (step.type === "gate.act") return this.gate(state, step, row, scope);
    if (step.type === "gate.review") return this.review(state, step, definition, row, scope);
    if (definition.sideEffect) return this.act(state, step, definition, row, scope);
    return this.compute(state, step, definition, row, scope);
  }

  /** A data or LLM step: resolve, validate, execute with retries, validate the output. */
  private async compute(
    state: RunState,
    step: CompiledStep,
    definition: StepDefinition,
    row: Step | undefined,
    scope: ItemScope | undefined,
  ): Promise<StepResult> {
    let input: Record<string, unknown>;
    try {
      input = definition.input.parse(state.values.resolve(step.with, scope));
    } catch (error) {
      await this.fail(state, step, row, scope, `Invalid input: ${message(error)}`);
      return { kind: "failed" };
    }
    const running = await this.markRunning(state, step, row, scope, input);
    const attempts = (step.retries ?? 0) + 1;
    // Every attempt's LLM calls count, the failed ones too.
    let usage: LlmUsage | undefined;
    const context = this.context(state, running, (more) => (usage = usage ? addUsage(usage, more) : more));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Nothing is saved unless the output matches the step's schema.
        const output = definition.output.parse(await this.executor(step).execute(input, context));
        await this.finish(state, running, output, usage);
        return { kind: "done", output };
      } catch (error) {
        if (error instanceof RunStopped) {
          await this.fail(state, step, running, scope, error.message, usage);
          return { kind: "stopped", reason: error.message };
        }
        lastError = error;
      }
    }
    await this.fail(state, step, running, scope, `${message(lastError)}${attempts > 1 ? ` (after ${attempts} attempts)` : ""}`, usage);
    return { kind: "failed" };
  }

  /** gate.act: shows the exact payload of its side-effect step as a proposal, and waits for the user's decision. */
  private async gate(state: RunState, step: CompiledStep, row: Step | undefined, scope: ItemScope | undefined): Promise<StepResult> {
    const targetId = step.with.for as string;
    if (row?.status === "WAITING") {
      const proposal = state.proposals.find((p) => p.stepId === row.stepId);
      if (!proposal || proposal.status === "PENDING_REVIEW") return { kind: "waiting" };
      const approved = proposal.status === "APPROVED";
      await this.finish(state, row, { approved });
      if (!approved) this.reject(state, targetId, scope);
      return { kind: "done", output: { approved } };
    }

    const target = state.definition.steps.find((s) => s.id === targetId);
    const targetDefinition = target ? this.catalog.get(target.type) : undefined;
    if (!target || !targetDefinition) {
      await this.fail(state, step, row, scope, `gate.act for unknown step "${targetId}"`);
      return { kind: "failed" };
    }

    let payload: Record<string, unknown>;
    let targets: TargetCheck[];
    try {
      payload = targetDefinition.input.parse(state.values.resolve(target.with, scope));
      targets = PolicyGuard.enforce(state.policy, targetDefinition, target.id, payload, (path) => state.values.lookup(path, scope));
    } catch (error) {
      await this.fail(
        state,
        step,
        row,
        scope,
        error instanceof PolicyViolation ? error.message : `Invalid payload for ${target.id}: ${message(error)}`,
      );
      return { kind: "failed" };
    }

    const gateRow = await this.markRunning(state, step, row, scope, { for: targetId });
    const proposal = await this.prisma.proposal.create({
      data: {
        userId: state.userId,
        runId: state.runId,
        stepId: gateRow.stepId,
        stepKey: target.id,
        itemIndex: scope?.index ?? null,
        status: state.dryRun ? "PREVIEW" : "PENDING_REVIEW",
        target: targets.map((t) => t.value).join(", ") || target.type,
        targets: targets as unknown as Prisma.InputJsonValue,
        originalPayload: payload as Prisma.InputJsonValue,
        reasoning: drewOn(state, target.with, scope),
      },
    });
    await this.proposalCreated(state, proposal);

    if (state.dryRun) {
      // Dry run: the proposal is a preview; continue as if approved, and the side-effect step is skipped.
      await this.finish(state, gateRow, { approved: true });
      return { kind: "done", output: { approved: true } };
    }
    const waiting = await this.prisma.step.update({ where: { stepId: gateRow.stepId }, data: { status: "WAITING" } });
    await this.saved(state, waiting);
    return { kind: "waiting" };
  }

  /** gate.review: the user picks which items proceed. The proposal lists the items; their approved selection is the
   * output. */
  private async review(
    state: RunState,
    step: CompiledStep,
    definition: StepDefinition,
    row: Step | undefined,
    scope: ItemScope | undefined,
  ): Promise<StepResult> {
    if (row?.status === "WAITING") {
      const proposal = state.proposals.find((p) => p.stepId === row.stepId);
      if (!proposal || proposal.status === "PENDING_REVIEW") return { kind: "waiting" };
      const offered = (proposal.originalPayload as { items?: unknown[] }).items ?? [];
      const chosen =
        proposal.status === "APPROVED" ? (((proposal.finalPayload ?? proposal.originalPayload) as { items?: unknown[] }).items ?? []) : [];
      // Only items that were offered: an edited selection can drop items, never add or change them.
      const offeredKeys = new Set(offered.map((item) => canonicalJson(item)));
      const output = { selected: chosen.filter((item) => offeredKeys.has(canonicalJson(item))) };
      await this.finish(state, row, output);
      return { kind: "done", output };
    }

    let input: { items: unknown[]; title?: string };
    try {
      input = definition.input.parse(state.values.resolve(step.with, scope)) as { items: unknown[]; title?: string };
    } catch (error) {
      await this.fail(state, step, row, scope, `Invalid input: ${message(error)}`);
      return { kind: "failed" };
    }
    const reviewRow = await this.markRunning(state, step, row, scope, input);
    if (state.dryRun) {
      const output = { selected: input.items };
      await this.finish(state, reviewRow, output);
      return { kind: "done", output };
    }
    const proposal = await this.prisma.proposal.create({
      data: {
        userId: state.userId,
        runId: state.runId,
        stepId: reviewRow.stepId,
        stepKey: step.id,
        itemIndex: scope?.index ?? null,
        status: "PENDING_REVIEW",
        target: input.title ?? `${input.items.length} item(s) to review`,
        originalPayload: { items: input.items } as Prisma.InputJsonValue,
      },
    });
    await this.proposalCreated(state, proposal);
    const waiting = await this.prisma.step.update({ where: { stepId: reviewRow.stepId }, data: { status: "WAITING" } });
    await this.saved(state, waiting);
    return { kind: "waiting" };
  }

  /** A side-effect step: only the approved payload, only if its hash matches, only if the policy allows its targets. */
  private async act(
    state: RunState,
    step: CompiledStep,
    definition: StepDefinition,
    row: Step | undefined,
    scope: ItemScope | undefined,
  ): Promise<StepResult> {
    if (state.dryRun) {
      await this.skip(state, step, scope?.index ?? null, "Dry run: not executed");
      return { kind: "skipped" };
    }
    if (row?.status === "RUNNING") {
      await this.fail(state, step, row, scope, "Interrupted while acting; not retried automatically");
      return { kind: "failed" };
    }

    const gateStep = state.definition.steps.find((s) => s.type === "gate.act" && s.with.for === step.id);
    const gateRow = gateStep ? state.rows.get(key(gateStep.id, scope?.index ?? null)) : undefined;
    const proposal = gateRow ? state.proposals.find((p) => p.stepId === gateRow.stepId) : undefined;
    if (!proposal || proposal.status !== "APPROVED" || !proposal.payloadHash) {
      await this.fail(state, step, row, scope, "No approved proposal for this step");
      return { kind: "failed" };
    }
    const payload = (proposal.finalPayload ?? proposal.originalPayload) as Record<string, unknown>;
    if (payloadHash(payload) !== proposal.payloadHash) {
      await this.fail(state, step, row, scope, "The payload changed after approval; refusing to act");
      await this.setProposalStatus(state, proposal.proposalId, "FAILED");
      return { kind: "failed" };
    }

    let input: Record<string, unknown>;
    try {
      input = definition.input.parse(payload);
      PolicyGuard.enforce(
        state.policy,
        definition,
        step.id,
        input,
        (path) => state.values.lookup(path, scope),
        proposal.approvedNewTargets,
      );
    } catch (error) {
      await this.fail(
        state,
        step,
        row,
        scope,
        error instanceof PolicyViolation ? error.message : `Invalid approved payload: ${message(error)}`,
      );
      await this.setProposalStatus(state, proposal.proposalId, "FAILED");
      return { kind: "failed" };
    }

    const until = await this.controls.rateLimitedUntil(state.controlled, step.type);
    if (until) return { kind: "deferred", until };

    const running = await this.markRunning(state, step, row, scope, input);
    await this.setProposalStatus(state, proposal.proposalId, "EXECUTING");
    try {
      const context = this.context(state, running, undefined, proposal.approvedNewTargets);
      const output = definition.output.parse(await this.executor(step).execute(input, context));
      await this.finish(state, running, output);
      await this.setProposalStatus(state, proposal.proposalId, "DONE");
      return { kind: "done", output };
    } catch (error) {
      // Never retried automatically (docs/design.md §2.6).
      await this.fail(state, step, running, scope, message(error));
      await this.setProposalStatus(state, proposal.proposalId, "FAILED");
      return { kind: "failed" };
    }
  }

  private reject(state: RunState, targetId: string, scope: ItemScope | undefined): void {
    if (scope) setOf(state.rejected, scope.source).add(scope.index);
    else state.rejectedSingles.add(targetId);
  }

  private executor(step: CompiledStep) {
    const executor = this.executors.get(step.type);
    if (!executor) throw new Error(`No executor for ${step.type}`);
    return executor;
  }

  private context(
    state: RunState,
    row: Step,
    recordUsage: (usage: LlmUsage) => void = () => undefined,
    approvedDomains: readonly string[] = [],
  ): StepContext {
    return {
      runId: state.runId,
      userId: state.userId,
      pipelineId: state.controlled.pipelineId,
      stepId: row.stepId,
      stepKey: row.stepKey,
      itemIndex: row.itemIndex,
      dryRun: state.dryRun,
      ...(state.definition.app ? { app: state.definition.app } : {}),
      ...(state.definition.refs?.appId ? { appId: state.definition.refs.appId } : {}),
      pipelineIds: state.definition.refs?.pipelines ?? {},
      recordUsage,
      budgetStops: () => this.controls.budgetStops(state.controlled),
      allowedDomains: [...state.policy.allowedDomains, ...approvedDomains],
      emit: (event, data) => this.emitEvent(state, event, data),
      attention: this.takeovers
        ? this.takeovers.for({
            runId: state.runId,
            userId: state.userId,
            pipelineId: state.controlled.pipelineId,
            stepKey: row.stepKey,
            itemIndex: row.itemIndex,
          })
        : NO_ATTENTION,
    };
  }

  private async emitEvent(state: RunState, event: EventJob["event"], data: Record<string, unknown>): Promise<void> {
    if (state.dryRun || !this.triggers) return;
    const source = { runId: state.runId, pipelineId: state.controlled.pipelineId, depth: state.chainDepth };
    await this.triggers({ userId: state.userId, event, data, source }).catch((error: Error) =>
      this.logger.warn(`${event} from run ${state.runId} not sent: ${error.message}`),
    );
  }

  private async markRunning(
    state: RunState,
    step: CompiledStep,
    row: Step | undefined,
    scope: ItemScope | undefined,
    input: unknown,
  ): Promise<Step> {
    const data = { status: "RUNNING" as const, input: input as Prisma.InputJsonValue, startedAt: new Date(), error: null };
    const saved = row
      ? await this.prisma.step.update({ where: { stepId: row.stepId }, data })
      : await this.prisma.step.create({
          data: { ...data, runId: state.runId, stepKey: step.id, itemIndex: scope?.index ?? null, type: step.type },
        });
    await this.saved(state, saved);
    return saved;
  }

  private async finish(state: RunState, row: Step, output: unknown, llmUsage?: LlmUsage): Promise<void> {
    const saved = await this.prisma.step.update({
      where: { stepId: row.stepId },
      data: { status: "DONE", output: output as Prisma.InputJsonValue, finishedAt: new Date(), ...usageData(llmUsage) },
    });
    await this.saved(state, saved);
    await this.spent(state, llmUsage);
  }

  /** A step that called the LLM: 80% of the budget, or all of it, is told on the Storm bot (M19-T2). */
  private async spent(state: RunState, llmUsage: LlmUsage | undefined): Promise<void> {
    if (llmUsage && llmUsage.costUsd > 0) await this.controls.tellBudget(state.userId);
  }

  private async skip(state: RunState, step: CompiledStep, itemIndex: number | null, reason: string): Promise<void> {
    const existing = state.rows.get(key(step.id, itemIndex));
    if (existing?.status === "SKIPPED") return;
    const data = { status: "SKIPPED" as const, error: reason, finishedAt: new Date() };
    const saved = existing
      ? await this.prisma.step.update({ where: { stepId: existing.stepId }, data })
      : await this.prisma.step.create({ data: { ...data, runId: state.runId, stepKey: step.id, itemIndex, type: step.type } });
    await this.saved(state, saved);
  }

  private async fail(
    state: RunState,
    step: CompiledStep,
    row: Step | undefined,
    scope: ItemScope | undefined,
    error: string,
    llmUsage?: LlmUsage,
  ): Promise<void> {
    const data = { status: "FAILED" as const, error, finishedAt: new Date(), ...usageData(llmUsage) };
    const saved = row
      ? await this.prisma.step.update({ where: { stepId: row.stepId }, data })
      : await this.prisma.step.create({
          data: { ...data, runId: state.runId, stepKey: step.id, itemIndex: scope?.index ?? null, type: step.type },
        });
    await this.saved(state, saved);
    await this.spent(state, llmUsage);
  }

  /** Keeps the run's state in step with a saved Step row, and reports it. */
  private async saved(state: RunState, row: Step): Promise<void> {
    state.rows.set(key(row.stepKey, row.itemIndex), row);
    await this.emit(state.userId, { type: "step", runId: state.runId, stepKey: row.stepKey, itemIndex: row.itemIndex, status: row.status });
  }

  private async proposalCreated(state: RunState, proposal: Proposal): Promise<void> {
    state.proposals.push(proposal);
    await this.emit(state.userId, { type: "proposal", proposalId: proposal.proposalId, runId: state.runId, status: proposal.status });
  }

  private async setProposalStatus(state: RunState, proposalId: string, status: ProposalStatusName): Promise<void> {
    await this.prisma.proposal.update({ where: { proposalId }, data: { status } });
    await this.emit(state.userId, { type: "proposal", proposalId, runId: state.runId, status });
  }

  private async emit(userId: string, event: AppEvent): Promise<void> {
    await this.events(userId, event).catch(() => undefined);
  }
}

function usageData(usage: LlmUsage | undefined): { llmUsage?: Prisma.InputJsonValue } {
  return usage ? { llmUsage: usage as unknown as Prisma.InputJsonValue } : {};
}

/** A result that ends this advance early. */
function interruption(result: StepResult, step: CompiledStep): Outcome | null {
  if (result.kind === "failed") return { status: "FAILED" };
  if (result.kind === "stopped") return { status: "ABORTED", summary: result.reason };
  if (result.kind === "deferred") {
    return {
      status: "QUEUED",
      resumeAt: result.until,
      summary: `Rate limit of ${step.type} reached; continues at ${result.until.toISOString()}`,
    };
  }
  return null;
}

function setOf(map: Map<string, Set<number>>, source: string): Set<number> {
  let set = map.get(source);
  if (!set) map.set(source, (set = new Set()));
  return set;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
