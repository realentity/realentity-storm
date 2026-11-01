import { type PrismaClient } from "@ai-me/db";
import { hostMatches } from "@ai-me/shared";
import { type FormFile } from "@ai-me/steps";
import { execFile } from "node:child_process";
import { type Page } from "playwright";
import { hostOf, SendGuard } from "../browser/agent-page";
import { type ArtifactStore } from "../browser/artifact-store";
import { type DocumentStore } from "../browser/document-store";
import { Quarantine } from "../browser/quarantine";
import { NO_ATTENTION, RunStopped, type StepContext, type StepExecutor } from "../runner/step-executor";
import { ownerOf, settle, unblock, type FormDependencies } from "./form-steps";
import { type BrowserDependencies } from "./browser-steps";

/** DOWNLOAD_MAX_MB's default. */
const DEFAULT_MAX_MB = 25;
const MAX_CONFIRMATION = 2000;
/** Reading a PDF's text takes longer than this only for a hostile one. */
const PDF_TIMEOUT_MS = 30_000;

interface DownloadInput {
  url: string;
  click?: string;
  headed: boolean;
  timeoutSeconds: number;
}

/**
 * browser.download (README §6, M11-T5): the address itself, or what a click on that page downloads, through the
 * quarantine: kept as the run's artifact only within DOWNLOAD_MAX_MB and when its content is an allowed type for its
 * extension; anything else is deleted and the step fails saying why.
 */
export class BrowserDownloadStep implements StepExecutor {
  readonly type = "browser.download";

  constructor(
    private readonly deps: BrowserDependencies,
    private readonly maxMb = DEFAULT_MAX_MB,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, click, headed, timeoutSeconds } = input as unknown as DownloadInput;
    const timeout = timeoutSeconds * 1000;
    const lease = await this.deps.pool.lease(headed, { storageState: await this.deps.sessions.load(context.userId, hostOf(url)), acceptDownloads: true });
    const attention = lease.headed ? context.attention : NO_ATTENTION;
    try {
      const page = await lease.context.newPage();
      page.setDefaultTimeout(timeout);
      const downloading = page.waitForEvent("download", { timeout });
      if (click) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        await settle(page);
        await unblock(page, attention);
        await attention.checkpoint(page.url());
        await page.locator(click).first().click();
      } else {
        // A file answers the navigation with a download, which Playwright reports as an aborted navigation.
        await page.goto(url, { timeout }).catch(() => undefined);
      }
      const download = await downloading.catch(() => {
        throw new Error(`Nothing was downloaded from ${url}${click ? ` by clicking "${click}"` : ""}`);
      });
      const result = await new Quarantine(this.deps.prisma, this.deps.artifacts, this.maxMb * 1_048_576).accept(download, ownerOf(context));
      if (!result.accepted) throw new Error(`The download ${result.name} was deleted: ${result.reason}`);
      const row = await this.deps.prisma.artifact.findUniqueOrThrow({ where: { artifactId: result.artifactId } });
      return { artifactId: result.artifactId, filename: result.name, mime: result.mime, size: result.size, sha256: row.sha256 ?? "" };
    } finally {
      await lease.close();
    }
  }
}

interface UploadInput {
  url: string;
  field: string;
  file: Omit<FormFile, "key">;
  submit?: string;
  timeoutSeconds: number;
}

/**
 * browser.upload (README §2.3, M11-T5): an approved document into a file field, in the live browser, on the allowed
 * sites only; the file is the one approved, checked by content. A field that isn't a single file input pauses the
 * run for me with nothing chosen.
 */
export class BrowserUploadStep implements StepExecutor {
  readonly type = "browser.upload";

  constructor(private readonly deps: FormDependencies) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, field, file, submit, timeoutSeconds } = input as unknown as UploadInput;
    const timeout = timeoutSeconds * 1000;
    const allowedHosts = [hostOf(url), ...(context.allowedDomains ?? [])];
    const guard = new SendGuard((host) => hostMatches(host, allowedHosts), "act");
    const lease = await this.deps.pool.lease(true, { storageState: await this.deps.sessions.load(context.userId, hostOf(url)), acceptDownloads: false });
    const attention = lease.headed ? context.attention : NO_ATTENTION;
    let page: Page | undefined;
    try {
      await guard.install(lease.context);
      page = await lease.context.newPage();
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await settle(page);
      await unblock(page, attention);

      const content = await this.deps.documents.approvedFile(this.deps.prisma, context.userId, { ...file, key: field });
      let input = page.locator(field);
      if (!(await isFileInput(page, field))) {
        await attention.needMe(`"${field}" isn't a file field on this page; nothing was uploaded`, page.url());
        if (!(await isFileInput(page, field))) throw new Error(`Nothing was uploaded: "${field}" isn't a file field`);
        input = page.locator(field);
      }
      await attention.checkpoint(page.url());
      await input.setInputFiles(content);
      if (submit) {
        await settle(page, timeout);
        await page.locator(submit).first().click();
      }
      await settle(page, timeout);
      const blocked = guard.drain();
      if (blocked.length) throw new Error(blocked.join("; "));
      const confirmation = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      await this.screenshot(page, context).catch(() => undefined);
      return { uploaded: true, url: page.url(), confirmation: confirmation.slice(0, MAX_CONFIRMATION) };
    } catch (error) {
      if (page) await this.screenshot(page, context).catch(() => undefined);
      if (error instanceof RunStopped) throw error;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await lease.close();
    }
  }

  private async screenshot(page: Page, context: StepContext): Promise<void> {
    const png = await page.screenshot({ fullPage: true, timeout: 10_000 });
    await this.deps.artifacts.save(this.deps.prisma, ownerOf(context), "screenshot", png, "png", "image/png");
  }
}

async function isFileInput(page: Page, field: string): Promise<boolean> {
  const all = page.locator(field);
  if ((await all.count().catch(() => 0)) !== 1) return false;
  return (await all.getAttribute("type").catch(() => null))?.toLowerCase() === "file";
}

interface ReadInput {
  document?: string;
  artifact?: string;
  maxChars: number;
}

/**
 * file.read (README §2.3, M11-T5): the text of a stored document of mine or of a kept download: text files as they
 * are, PDFs' text layer. Its output names the document by id and SHA-256, so browser.upload sends exactly that file.
 */
export class FileReadStep implements StepExecutor {
  readonly type = "file.read";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly artifacts: ArtifactStore,
    private readonly documents?: DocumentStore,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { document, artifact, maxChars } = input as unknown as ReadInput;
    if (!document === !artifact) throw new Error("file.read reads one file: give either document or artifact");
    let file: { filename: string; mime: string; sha256: string; content: Buffer; document: string | null; documentId: string | null; artifactId: string | null };
    if (document) {
      if (!this.documents) throw new Error("My documents aren't available here");
      const read = await this.documents.read(this.prisma, context.userId, document);
      file = { filename: read.file.filename, mime: read.mimeType, sha256: read.file.sha256, content: read.buffer, document, documentId: read.file.documentId, artifactId: null };
    } else {
      const read = await this.artifacts.readDownload(this.prisma, context.userId, artifact!);
      file = { filename: read.name, mime: read.mime, sha256: read.sha256, content: read.content, document: null, documentId: null, artifactId: artifact! };
    }
    const text = (await textOf(file.mime, file.content, file.filename)).replace(/\r\n/g, "\n").trim();
    const { content: _, ...rest } = file;
    return { ...rest, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
}

/** Text files as they are; PDFs' text layer (a scan without one reads as nothing). Other types can't be read. */
async function textOf(mime: string, content: Buffer, filename: string): Promise<string> {
  if (mime.startsWith("text/") || /\.(txt|md|csv|json)$/i.test(filename)) return content.toString("utf8");
  if (mime === "application/pdf" || content.subarray(0, 5).toString("latin1") === "%PDF-") return pdfText(content);
  throw new Error(`${filename} is a ${mime} file: only text files and PDFs can be read`);
}

/** Runs in a child Node process: the PDF on stdin, its text on stdout. */
const PDF_TEXT = `
const { PDFParse } = require(${JSON.stringify(require.resolve("pdf-parse"))});
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)) });
  try { process.stdout.write((await parser.getText({ pageJoiner: "\\n" })).text); } catch (e) { process.stderr.write(String(e && e.message || e)); process.exitCode = 1; }
  finally { await parser.destroy(); }
});`;

/**
 * A PDF's text, parsed in a child process: a PDF from a site is untrusted input, and pdf.js stays out of the worker
 * (its own worker module also loads only outside Jest's module system).
 */
function pdfText(content: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", PDF_TEXT], { timeout: PDF_TIMEOUT_MS, maxBuffer: 20 * 1_048_576, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`The PDF couldn't be read: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.end(content);
  });
}
