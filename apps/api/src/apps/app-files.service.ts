import { type AppFile } from "@realentity/storm-db";
import { asFileRef, FILE_KINDS, readAppSource, type AppDefinition, type FileRef, type ServerEnv } from "@realentity/storm-shared";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import sharp from "sharp";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { type UploadedFile } from "../documents/documents.service";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Images a browser shows as they are; never SVG (it can hold script). */
const IMAGES: { mime: string; extension: string; matches: (head: Buffer) => boolean }[] = [
  { mime: "image/png", extension: ".png", matches: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", extension: ".jpg", matches: (h) => h.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { mime: "image/webp", extension: ".webp", matches: (h) => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP" },
  { mime: "image/gif", extension: ".gif", matches: (h) => /^GIF8[79]a$/.test(h.subarray(0, 6).toString("latin1")) },
];

/** Other files a `file` field takes, by content; office files by their name once their content is a zip. */
const DOCUMENTS: { mime: string; extensions: string[]; matches: (head: Buffer, all: Buffer) => boolean }[] = [
  { mime: "application/pdf", extensions: [".pdf"], matches: (h) => h.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: [".docx"], matches: (h) => h.subarray(0, 4).equals(ZIP) },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: [".xlsx"], matches: (h) => h.subarray(0, 4).equals(ZIP) },
  { mime: "application/vnd.oasis.opendocument.text", extensions: [".odt"], matches: (h) => h.subarray(0, 4).equals(ZIP) },
  { mime: "application/vnd.oasis.opendocument.spreadsheet", extensions: [".ods"], matches: (h) => h.subarray(0, 4).equals(ZIP) },
  { mime: "text/plain", extensions: [".txt", ".md"], matches: (_h, all) => isText(all) },
  { mime: "text/csv", extensions: [".csv"], matches: (_h, all) => isText(all) },
];

/** A thumbnail's width; an image larger than this many pixels isn't read (a decompression bomb). */
const THUMB_WIDTH = 480;
const MAX_PIXELS = 60_000_000;
/** An upload whose form was never saved goes after this long. */
const UNSAVED_FOR_MS = 24 * 3_600_000;

/**
 * M46: the files and images of entities' fields. Uploaded on the form first (unsaved: no entity yet), then attached
 * when the form is saved: the entity keeps { id, name, mime, size }, never the bytes. Stored under
 * DOCUMENTS_DIR/app-files by content type (never by the name or the browser's word), an image with a WebP thumbnail.
 * A file replaced or cleared on the form, or whose entity is deleted, goes with it.
 */
@Injectable()
export class AppFilesService {
  private readonly logger = new Logger(AppFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async upload(userId: string, appId: string, typeName: string, fieldName: string, file: UploadedFile | undefined): Promise<FileRef> {
    const definition = await this.definition(userId, appId);
    const field = Object.hasOwn(definition.types, typeName) ? definition.types[typeName].fields[fieldName] : undefined;
    if (!field || !FILE_KINDS.includes(field.type)) throw new BadRequestException(`${typeName}.${fieldName} isn't a file or an image`);
    if (!file || file.size === 0) throw new BadRequestException("No file, or an empty one");
    if (file.size > this.env.DOWNLOAD_MAX_MB * 1_048_576) throw new PayloadTooLargeException(`Larger than ${this.env.DOWNLOAD_MAX_MB} MB`);
    const filename = safeName(file.originalname);
    const head = file.buffer.subarray(0, 16);
    const image = IMAGES.find((t) => t.matches(head));
    const document = image ? undefined : DOCUMENTS.find((t) => t.extensions.includes(extname(filename).toLowerCase()) && t.matches(head, file.buffer));
    if (field.type === "image" && !image) throw new BadRequestException("Only a PNG, JPEG, WebP or GIF image");
    if (!image && !document) throw new BadRequestException("Only an image, a PDF, an office document (DOCX, XLSX, ODT, ODS) or a text file (TXT, MD, CSV)");

    const appFileId = randomUUID();
    const extension = image ? image.extension : extname(filename).toLowerCase();
    const path = `app-files/${appFileId}${extension}`;
    const thumb = image ? await thumbnail(file.buffer) : null;
    if (field.type === "image" && !thumb) throw new BadRequestException("The image can't be read");
    const root = resolve(this.env.DOCUMENTS_DIR);
    await mkdir(resolve(root, "app-files"), { recursive: true });
    await writeFile(resolve(root, path), file.buffer, { mode: 0o640 });
    const thumbPath = thumb ? `app-files/${appFileId}.thumb.webp` : null;
    if (thumb && thumbPath) await writeFile(resolve(root, thumbPath), thumb, { mode: 0o640 });
    const row = await this.prisma.client.appFile.create({
      data: {
        appFileId,
        appId,
        type: typeName,
        field: fieldName,
        key: null,
        filename,
        mime: image ? image.mime : document!.mime,
        size: file.size,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        path,
        thumbPath,
      },
    });
    await this.sweep(appId);
    return refOf(row);
  }

  /**
   * The form's file ids swapped for their references, each checked to be an upload to this App, type and field
   * (unsaved, or already this entity's); the uploads are then the entity's.
   */
  async attach(appId: string, typeName: string, key: string, values: Record<string, unknown>, fileFields: string[]): Promise<Record<string, unknown>> {
    const out = { ...values };
    for (const name of fileFields) {
      const id = (values[name] as { id?: string } | null | undefined)?.id;
      if (!id) continue;
      const row = await this.prisma.client.appFile.findFirst({ where: { appFileId: id, appId, type: typeName, field: name } });
      if (!row || (row.key !== null && row.key !== key)) {
        throw new BadRequestException({ message: "Some values can't be saved", errors: [{ path: name, message: "isn't a file uploaded to this field" }] });
      }
      if (row.key === null) await this.prisma.client.appFile.update({ where: { appFileId: id }, data: { key } });
      out[name] = refOf(row);
    }
    return out;
  }

  /** After a save: the entity's files its values no longer name (replaced or cleared on the form) go. */
  async release(appId: string, typeName: string, key: string, ...held: unknown[]): Promise<void> {
    const keep = new Set(held.flatMap((v) => Object.values((v ?? {}) as Record<string, unknown>)).flatMap((v) => (asFileRef(v) ? [asFileRef(v)!.id] : [])));
    const rows = await this.prisma.client.appFile.findMany({ where: { appId, type: typeName, key } });
    await this.drop(rows.filter((r) => !keep.has(r.appFileId)));
  }

  /** Every file of an entity, gone with it. */
  async removeEntity(appId: string, typeName: string, key: string): Promise<void> {
    await this.drop(await this.prisma.client.appFile.findMany({ where: { appId, type: typeName, key } }));
  }

  /** Every file of an App, before it is deleted (its rows go with it, the files on disk here). */
  async removeApp(appId: string): Promise<void> {
    await this.drop(await this.prisma.client.appFile.findMany({ where: { appId } }));
  }

  async file(userId: string, appFileId: string, thumb: boolean): Promise<{ stream: ReadStream; mime: string; name: string; size: number; image: boolean }> {
    const row = await this.prisma.client.appFile.findFirst({ where: { appFileId, app: { userId } } });
    const path = thumb ? row?.thumbPath : row?.path;
    if (!row || !path) throw new NotFoundException();
    const full = this.inside(path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException("The file is gone");
    const image = thumb || IMAGES.some((t) => t.mime === row.mime);
    return { stream: createReadStream(full), mime: thumb ? "image/webp" : row.mime, name: row.filename, size: info.size, image };
  }

  /** Uploads to this App whose form was never saved, older than a day. */
  private async sweep(appId: string): Promise<void> {
    await this.drop(await this.prisma.client.appFile.findMany({ where: { appId, key: null, dateCreated: { lt: new Date(Date.now() - UNSAVED_FOR_MS) } } }));
  }

  private async drop(rows: AppFile[]): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.client.appFile.deleteMany({ where: { appFileId: { in: rows.map((r) => r.appFileId) } } });
    for (const row of rows) {
      for (const path of [row.path, row.thumbPath]) {
        if (path) await rm(this.inside(path), { force: true }).catch((error: unknown) => this.logger.warn(`Couldn't remove ${path}: ${String(error)}`));
      }
    }
  }

  private inside(path: string): string {
    const root = resolve(this.env.DOCUMENTS_DIR);
    const full = resolve(root, path);
    const within = relative(root, full);
    if (within.startsWith("..") || isAbsolute(within)) throw new NotFoundException();
    return full;
  }

  private async definition(userId: string, appId: string): Promise<AppDefinition> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } }) : null;
    if (!app || !version) throw new NotFoundException();
    return readAppSource(version.source);
  }
}

function refOf(row: AppFile): FileRef {
  return { id: row.appFileId, name: row.filename, mime: row.mime, size: row.size };
}

/** A WebP thumbnail, turned as the camera held it, without the photo's metadata (GPS); null when it isn't an image. */
async function thumbnail(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Text: valid UTF-8 without NUL bytes. */
function isText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** The name the page shows: no path, no control characters, at most 120 characters. */
function safeName(name: string): string {
  const base = [...(name.split(/[/\\]/).pop() ?? "")]
    .filter((c) => c.charCodeAt(0) >= 0x20 && !'"<>|:*?'.includes(c))
    .join("")
    .trim();
  return (base || "file").slice(-120);
}
