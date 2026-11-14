import { type AppFile, type PrismaClient } from "@realentity/storm-db";
import { FileProblem, readStored, recordFile, storeFile, sweepFiles, detectFile, safeName, type EntityFile } from "@realentity/storm-files";
import { downloadTelegramFile, FILE_KINDS, fileRefId, type TelegramConfig } from "@realentity/storm-shared";
import { type EmailMessage } from "@realentity/storm-steps";
import { type ArtifactStore } from "../browser/artifact-store";
import { type MailConnector } from "../mail/mail-connector";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { appType } from "./entity-steps";

/** DOWNLOAD_MAX_MB's default. */
const DEFAULT_MAX_MB = 25;
/** An email's attachments are read from a message at most this large. */
const MAX_MESSAGE_BYTES = 30 * 1_048_576;

/**
 * M46: an App's entity files as the worker sees them: read (file.read, llm.extract) only when they are the pipeline's own
 * App's; kept (file.keep) under DOCUMENTS_DIR/app-files, for data.save to attach.
 */
export class AppFileStore {
  constructor(readonly root: string) {}

  /** An entity's file of the pipeline's App: its row and content. Anything else (another App's, a made-up id) isn't found. */
  async read(prisma: PrismaClient, context: StepContext, value: unknown): Promise<{ row: AppFile; content: Buffer }> {
    const id = fileRefId(value);
    if (!id) throw new Error("Not a stored file: give an entity's file field, e.g. {{item.scan}}");
    const appId = await appOf(prisma, context);
    const row = await prisma.appFile.findFirst({ where: { appFileId: id, appId, key: { not: null } } });
    if (!row) throw new Error(`No file ${id} in this pipeline's App`);
    return { row, content: await readStored(this.root, row.path) };
  }
}

/** The pipeline's App's id: by the id its version was saved with, else by name (M39-T3). */
async function appOf(prisma: PrismaClient, context: StepContext): Promise<string> {
  if (!context.app) throw new Error("Files are an App's: this pipeline has no app:");
  const app = context.appId
    ? await prisma.app.findFirst({ where: { appId: context.appId, userId: context.userId } })
    : await prisma.app.findUnique({ where: { userId_name: { userId: context.userId, name: context.app } } });
  if (!app) throw new Error(`There is no App named "${context.app}"`);
  return app.appId;
}

interface KeepInput {
  type: string;
  field: string;
  message?: EmailMessage;
  mailbox: string;
  artifact?: string;
  telegram?: { telegramFileId: string; name: string; mime: string; size: number } | null;
  max: number;
}

/**
 * file.keep (M46-T4): an email's attachments, or a file browser.download kept, stored as files of a type's file or
 * image field (checked by content: an image field takes only images). Their references go into data.save's items,
 * which attaches them to the entity; kept files no entity took go after a day. Nothing leaves Storm. A dry run stores
 * nothing and says how many it would keep.
 */
export class FileKeepStep implements StepExecutor {
  readonly type = "file.keep";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: AppFileStore,
    private readonly mail: MailConnector,
    private readonly artifacts?: ArtifactStore,
    private readonly maxMb = DEFAULT_MAX_MB,
    /** M49: the bot, to download a file sent with a command; tests give a stand-in fetch. */
    private readonly telegram?: { config: TelegramConfig; fetch?: typeof fetch },
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { type: typeName, field: fieldName, message, mailbox, artifact, telegram, max } = input as unknown as KeepInput;
    const sources = [message, artifact, telegram].filter((s) => s !== undefined);
    if (sources.length !== 1) throw new Error("file.keep keeps the files of one email (message), one download (artifact) or one Telegram message (telegram)");
    const { appId, type } = await appType(this.prisma, context, typeName);
    const field = type.fields[fieldName];
    if (!field || !FILE_KINDS.includes(field.type)) throw new Error(`${typeName}.${fieldName} isn't a file or an image`);
    if (field.mine) throw new Error(`${typeName}.${fieldName} is mine: a pipeline can't write it`);
    const kind = field.type as "file" | "image";

    const candidates: { name: string; content: Buffer }[] = [];
    if (message) {
      if (message.attachments.length > 0) {
        const attachments = await this.mail.attachments(context.userId, { mailbox, uid: message.uid, maxBytes: MAX_MESSAGE_BYTES });
        candidates.push(...attachments.map((a) => ({ name: a.filename ?? "attachment", content: a.content })));
      }
    } else if (telegram !== undefined) {
      // A command sent without a photo or file: nothing to keep.
      if (telegram !== null) {
        if (!this.telegram?.config.botToken) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN)");
        const content = await downloadTelegramFile(this.telegram.config, telegram.telegramFileId, Math.min(this.maxMb * 1_048_576, 20 * 1_048_576), this.telegram.fetch);
        candidates.push({ name: telegram.name, content });
      }
    } else {
      if (!this.artifacts) throw new Error("Downloads aren't available here");
      const read = await this.artifacts.readDownload(this.prisma, context.userId, artifact!);
      candidates.push({ name: read.name, content: read.content });
    }

    const kept: EntityFile[] = [];
    const skipped: { name: string; reason: string }[] = [];
    let found = 0;
    for (const candidate of candidates) {
      const name = safeName(candidate.name);
      if (found >= max) {
        skipped.push({ name, reason: `more than ${max}` });
        continue;
      }
      if (candidate.content.length > this.maxMb * 1_048_576) {
        skipped.push({ name, reason: `larger than ${this.maxMb} MB` });
        continue;
      }
      const detected = detectFile(candidate.content, name, kind);
      if ("problem" in detected) {
        skipped.push({ name, reason: detected.problem });
        continue;
      }
      found++;
      if (context.dryRun) continue;
      try {
        const stored = await storeFile(this.files.root, candidate.content, name, kind);
        kept.push(await recordFile(this.prisma, appId, typeName, fieldName, stored));
      } catch (error) {
        if (!(error instanceof FileProblem)) throw error;
        found--;
        skipped.push({ name, reason: error.message });
      }
    }
    if (!context.dryRun) await sweepFiles(this.prisma, this.files.root, appId);
    return { files: kept, first: kept[0] ?? null, found, skipped };
  }
}
