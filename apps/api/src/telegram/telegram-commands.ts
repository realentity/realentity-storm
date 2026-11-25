import {
  BUILT_IN_COMMANDS,
  isEventTrigger,
  setTelegramCommands,
  type CompiledDefinition,
  type TelegramCommandsView,
  type Trigger,
} from "@realentity/storm-shared";
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { TelegramNotices } from "./telegram-notices";

/** A pipeline's command in the registry. */
export interface PipelineCommand {
  command: string;
  description: string;
  pipelineId: string;
  pipelineVersionId: string;
  name: string;
}

/** The command a trigger answers to (M49), if it is a telegram.command. */
export function commandOf(trigger: Trigger): { command: string; description?: string } | null {
  return isEventTrigger(trigger) && trigger.on === "telegram.command"
    ? { command: trigger.command, description: trigger.description }
    : null;
}

/**
 * M49: the Storm bot's commands, in one place: its own (/run, /inbox, …) and those of the pipelines that are on with a
 * telegram.command trigger. A command is one pipeline's: switching on (or saving, while on) a second with the same is
 * refused, with a name to use instead. The bot's menu (setMyCommands) follows the registry.
 */
@Injectable()
export class TelegramCommands implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramCommands.name);
  /** The menu last sent: sent again only when it changes. */
  private sent: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: TelegramNotices,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const users = await this.prisma.client.user.findMany({ select: { userId: true } }).catch(() => []);
    for (const { userId } of users) await this.sync(userId);
  }

  /** The commands of the user's pipelines that are on. */
  async registry(userId: string): Promise<PipelineCommand[]> {
    return (await this.ofPipelines(userId, true)).map(({ enabled: _enabled, ...command }) => command);
  }

  /**
   * Every command, as Settings lists them: Storm's own, then the pipelines' by command, those that are off too (each
   * answers only once on), with the pipeline that has it now when one that is off can't have it.
   */
  async list(userId: string): Promise<TelegramCommandsView> {
    const pipelines = await this.ofPipelines(userId, false);
    const own = BUILT_IN_COMMANDS.filter((c) => c.command !== "start").map((c) => ({ ...c, pipeline: null, answers: true, takenBy: null }));
    const theirs = pipelines
      .map((p) => ({
        command: p.command,
        description: p.description,
        pipeline: { pipelineId: p.pipelineId, name: p.name, enabled: p.enabled },
        answers: p.enabled,
        takenBy: p.enabled ? null : (pipelines.find((o) => o.enabled && o.command === p.command)?.name ?? null),
      }))
      .sort(
        (a, b) =>
          a.command.localeCompare(b.command) || Number(b.answers) - Number(a.answers) || a.pipeline.name.localeCompare(b.pipeline.name),
      );
    return { configured: await this.notices.configured(), commands: [...own, ...theirs] };
  }

  /** The commands of the user's pipelines; only those that are on, or all. */
  private async ofPipelines(userId: string, onlyOn: boolean): Promise<(PipelineCommand & { enabled: boolean })[]> {
    const pipelines = await this.prisma.client.pipeline.findMany({
      where: { userId, ...(onlyOn ? { enabled: true } : {}), currentVersionId: { not: null } },
      orderBy: { name: "asc" },
    });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
      select: { pipelineVersionId: true, definition: true },
    });
    const byId = new Map(versions.map((v) => [v.pipelineVersionId, v.definition as unknown as CompiledDefinition]));
    return pipelines.flatMap((p) => {
      const command = commandOf(byId.get(p.currentVersionId!)?.trigger ?? "manual");
      return command
        ? [
            {
              command: command.command,
              description: command.description ?? p.name,
              pipelineId: p.pipelineId,
              pipelineVersionId: p.currentVersionId!,
              name: p.name,
              enabled: p.enabled,
            },
          ]
        : [];
    });
  }

  /** The pipeline a command starts, if any. */
  async find(userId: string, command: string): Promise<PipelineCommand | undefined> {
    return (await this.registry(userId)).find((c) => c.command === command);
  }

  /**
   * Why this pipeline, on with this definition, can't have its command: another pipeline that is on has it. Null: it
   * can (or it has none). Says a name to use instead: the App's (or the pipeline's) name before it.
   */
  async clash(
    userId: string,
    pipelineId: string,
    definition: Pick<CompiledDefinition, "trigger" | "app" | "name">,
  ): Promise<string | null> {
    const wanted = commandOf(definition.trigger);
    if (!wanted) return null;
    const taken = (await this.registry(userId)).find((c) => c.command === wanted.command && c.pipelineId !== pipelineId);
    if (!taken) return null;
    const prefix = (definition.app ?? definition.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    const instead = `${prefix}_${wanted.command}`.slice(0, 32);
    return `/${wanted.command} is already "${taken.name}"'s command: switch that one off, or give this one another, e.g. ${instead}`;
  }

  /** M63: another bot or chat was saved: the next sync sends the menu again. */
  forgetMenu(): void {
    this.sent = null;
  }

  /** The bot's menu, as the registry is now: Storm's own commands, then the pipelines'. Never throws. */
  async sync(userId: string): Promise<void> {
    if (!(await this.notices.configured())) return;
    try {
      const commands = [...BUILT_IN_COMMANDS.filter((c) => c.command !== "start"), ...(await this.registry(userId))].map((c) => ({
        command: c.command,
        description: c.description,
      }));
      const menu = JSON.stringify(commands);
      if (menu === this.sent) return;
      await setTelegramCommands(this.notices.config, commands, this.notices.send);
      this.sent = menu;
    } catch (error) {
      this.logger.warn(`The bot's menu wasn't updated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
