import { payloadHash } from "@ai-me/crypto";
import { addUsage, type LlmUsage } from "@ai-me/llm";
import { type Prisma, type PrismaClient, type Proposal, type RunStatus, type Step } from "@ai-me/db";
import {
  canonicalJson,
  type AppEvent,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompiledStep,
  type ProposalStatusName,
} from "@ai-me/shared";
import { type StepCatalog, type StepDefinition } from "@ai-me/steps";
import { PolicyGuard, PolicyViolation, type TargetCheck } from "./policy-guard";
import { RunControls, type ControlledRun } from "./run-controls";
import { RunValues, sourceOf, type ItemScope } from "./run-values";
import { type ExecutorRegistry, type StepContext } from "./step-executor";

/** Where the runner reports progress (the web app's live updates). Must not throw; a lost event only delays a refresh. */
export type EventSink = (userId: string, event: AppEvent) => Promise<void>;

const noEvents: EventSink = () => Promise.resolve();

export interface StartOptions {
  trigger: "schedule" | "manual" | "event" | "dry-run";
  dryRun?: boolean;
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
}

const key = (stepKey: string, itemIndex: number | null): string => `${stepKey}#${itemIndex ?? ""}`;

/**
 * Interprets a PipelineVersion step by step (README §2.6). All progress is in Step rows, so a run resumes from the
 * last completed step after a restart; nothing that finished runs again, and side-effect steps never run twice.
 * Gates create proposals and pause the run; a side-effect step executes only the approved, hash-checked payload.
 */
export class PipelineRunner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: StepCatalog,
    private readonly executors: ExecutorRegistry,
    private readonly controls: RunControls = new RunControls(prisma),
    private readonly events: EventSink = noEvents,
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
        headed: this.catalog.needsHeaded(definition.steps),
        status: "QUEUED",
      },
    });
    await this.emit(run.userId, { type: "run", runId: run.runId, pipelineId: version.pipelineId, status: "QUEUED" });
    return run.runId;
  }

  /**
   * Runs as far as possible: until done, failed, stopped, held back by a rate limit (QUEUED, with `resumeAt`), or
   * waiting for me. Returns the run's status afterwards.
   */
  async advance(runId: string): Promise<RunStatus> {
    for (;;) {
      // Claim the run, so two workers (or a retried job) never advance it at the same time.
      const claimed = await this.prisma.run.updateMany({
        where: { runId, status: { in: ["QUEUED", "WAITING_FOR_USER"] } },
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
      // A decision made during this advance isn't in its state, and the job sent for it found the run claimed.
      // The status is saved first, so either that job claims the run now, or this check sees the decision.
      if (outcome.status !== "WAITING_FOR_USER" || !(await this.hasUnreadDecision(runId))) return outcome.status;
    }
  }

  /**
   * After a restart: runs left RUNNING were interrupted. Their interrupted steps re-run on the next advance, except
   * side-effect steps, which fail (the action may or may not have happened; I decide). Returns the runs to advance.
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
      values: new RunValues(),
      rejected: new Map(),
      blocked: new Map(),
      rejectedSingles: new Set(),
    };
  }

  private async execute(state: RunState): Promise<Outcome> {
    for (const step of state.definition.steps) {
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
        const result = await this.runOne(state, step, definition, undefined);
        const interrupted = interruption(result, step);
        if (interrupted) return interrupted;
        if (result.kind === "waiting") return { status: "WAITING_FOR_USER" };
        state.values.set(step, result.kind === "done" ? result.output : undefined);
        continue;
      }

      const source = sourceOf(step.forEach);
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
        const result = await this.runOne(state, step, definition, { source, index, item });
        const interrupted = interruption(result, step);
        if (interrupted) return interrupted;
        if (result.kind === "waiting") blocked.add(index);
        if (result.kind === "done") outputs[index] = result.output;
      }
      state.values.set(step, outputs);
    }
    return { status: [...state.blocked.values()].some((items) => items.size > 0) ? "WAITING_FOR_USER" : "DONE" };
  }

  private async runOne(state: RunState, step: CompiledStep, definition: StepDefinition, scope: ItemScope | undefined): Promise<StepResult> {
    const itemIndex = scope?.index ?? null;
    const row = state.rows.get(key(step.id, itemIndex));
    if (row?.status === "DONE") return { kind: "done", output: row.output };
    if (row?.status === "SKIPPED") return { kind: "skipped" };
    if (row?.status === "FAILED") return { kind: "failed" };

    // Step boundary: the kill switch and the budget apply to runs already in progress.
    const reason = await this.controls.stopReason(state.controlled, step.type);
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
        lastError = error;
      }
    }
    await this.fail(state, step, running, scope, `${message(lastError)}${attempts > 1 ? ` (after ${attempts} attempts)` : ""}`, usage);
    return { kind: "failed" };
  }

  /** gate.act: shows the exact payload of its side-effect step as a proposal, and waits for my decision. */
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

  /** gate.review: I pick which items proceed. The proposal lists the items; my approved selection is the output. */
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
      const output = definition.output.parse(await this.executor(step).execute(input, this.context(state, running)));
      await this.finish(state, running, output);
      await this.setProposalStatus(state, proposal.proposalId, "DONE");
      return { kind: "done", output };
    } catch (error) {
      // Never retried automatically (README §2.6).
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

  private context(state: RunState, row: Step, recordUsage: (usage: LlmUsage) => void = () => undefined): StepContext {
    return {
      runId: state.runId,
      userId: state.userId,
      stepId: row.stepId,
      stepKey: row.stepKey,
      itemIndex: row.itemIndex,
      dryRun: state.dryRun,
      recordUsage,
    };
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
