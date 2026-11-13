import { type AppFile, type PrismaClient } from "@realentity/storm-db";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import sharp from "sharp";

/**
 * M46: the files and images of App entities, shared by the api (uploads on forms) and the worker (files a pipeline
 * keeps, files the LLM reads). Checked by content, never by the name or a sender's word; stored under
 * DOCUMENTS_DIR/app-files, an image with a WebP thumbnail.
 */

export type FileKind = "file" | "image";

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

export const IMAGE_MIMES: readonly string[] = IMAGES.map((t) => t.mime);

/** A thumbnail's width; an image larger than this many pixels isn't read (a decompression bomb). */
const THUMB_WIDTH = 480;
const MAX_PIXELS = 60_000_000;
/** The LLM sees an image at most this long on its longest side (larger ones it scales down anyway). */
const VISION_EDGE = 1568;

/** What the content is, for a field of that kind; null and why when the field doesn't take it. */
export function detectFile(content: Buffer, filename: string, kind: FileKind): { mime: string; extension: string; image: boolean } | { problem: string } {
  const head = content.subarray(0, 16);
  const image = IMAGES.find((t) => t.matches(head));
  if (image) return { mime: image.mime, extension: image.extension, image: true };
  if (kind === "image") return { problem: "Only a PNG, JPEG, WebP or GIF image" };
  const extension = extname(filename).toLowerCase();
  const document = DOCUMENTS.find((t) => t.extensions.includes(extension) && t.matches(head, content));
  if (document) return { mime: document.mime, extension, image: false };
  return { problem: "Only an image, a PDF, an office document (DOCX, XLSX, ODT, ODS) or a text file (TXT, MD, CSV)" };
}

export interface StoredFile {
  appFileId: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  /** Relative to the documents folder. */
  path: string;
  thumbPath: string | null;
}

/**
 * The content written under `root`/app-files, checked first; an image gets its thumbnail. Throws a FileProblem the
 * caller says as it is.
 */
export async function storeFile(root: string, content: Buffer, originalName: string, kind: FileKind): Promise<StoredFile> {
  if (content.length === 0) throw new FileProblem("No file, or an empty one");
  const filename = safeName(originalName);
  const detected = detectFile(content, filename, kind);
  if ("problem" in detected) throw new FileProblem(detected.problem);
  const thumb = detected.image ? await thumbnail(content) : null;
  if (detected.image && !thumb) throw new FileProblem("The image can't be read");
  const appFileId = randomUUID();
  const path = `app-files/${appFileId}${detected.extension}`;
  const thumbPath = thumb ? `app-files/${appFileId}.thumb.webp` : null;
  const base = resolve(root);
  await mkdir(resolve(base, "app-files"), { recursive: true });
  await writeFile(resolve(base, path), content, { mode: 0o640 });
  if (thumb && thumbPath) await writeFile(resolve(base, thumbPath), thumb, { mode: 0o640 });
  return {
    appFileId,
    filename,
    mime: detected.mime,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    path,
    thumbPath,
  };
}

/** A problem with a file that the user or the run is told as it is. */
export class FileProblem extends Error {}

/** A stored path inside `root`; anything that would leave it is refused. */
export function insideRoot(root: string, path: string): string {
  const base = resolve(root);
  const full = resolve(base, path);
  const within = relative(base, full);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) throw new FileProblem("Not a stored file");
  return full;
}

export async function readStored(root: string, path: string): Promise<Buffer> {
  return readFile(insideRoot(root, path));
}

/** Stored files gone; one already missing isn't a failure. */
export async function removeStored(root: string, paths: (string | null)[]): Promise<void> {
  for (const path of paths) if (path) await rm(insideRoot(root, path), { force: true });
}

/**
 * An image as the LLM is sent it: turned upright, at most VISION_EDGE on its longest side, as JPEG (a PNG stays PNG,
 * for text in screenshots), without metadata.
 */
export async function forVision(content: Buffer, mime: string): Promise<{ mime: string; data: Buffer }> {
  const image = sharp(content, { limitInputPixels: MAX_PIXELS, animated: false })
    .rotate()
    .resize({ width: VISION_EDGE, height: VISION_EDGE, fit: "inside", withoutEnlargement: true });
  return mime === "image/png" ? { mime, data: await image.png().toBuffer() } : { mime: "image/jpeg", data: await image.jpeg({ quality: 85 }).toBuffer() };
}

/** A WebP thumbnail, turned as the camera held it, without the photo's metadata (GPS); null when it isn't an image. */
async function thumbnail(content: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(content, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Text: valid UTF-8 without NUL bytes. */
function isText(content: Buffer): boolean {
  if (content.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/** The name a page shows: no path, no control characters, at most 120 characters. */
export function safeName(name: string): string {
  const base = [...(name.split(/[/\\]/).pop() ?? "")]
    .filter((c) => c.charCodeAt(0) >= 0x20 && !'"<>|:*?'.includes(c))
    .join("")
    .trim();
  return (base || "file").slice(-120);
}

/* The database side: an entity's files as rows (AppFile), attached when the entity is saved, removed when it no longer names them. */

/** A stored file as an entity holds it: never its bytes. Same shape as FileRef in @realentity/storm-shared. */
export interface EntityFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export function entityFileOf(row: Pick<AppFile, "appFileId" | "filename" | "mime" | "size">): EntityFile {
  return { id: row.appFileId, name: row.filename, mime: row.mime, size: row.size };
}

/** A stored file recorded for an App's type and field, not yet any entity's. */
export async function recordFile(prisma: PrismaClient, appId: string, type: string, field: string, stored: StoredFile): Promise<EntityFile> {
  const row = await prisma.appFile.create({ data: { ...stored, appId, type, field, key: null } });
  return entityFileOf(row);
}

/**
 * Each file field's value (an id, or { id, … }) swapped for the stored file's reference, once it is known to be this
 * App's, type's and field's, and not yet another entity's; it is then this entity's. `refuse` says the field that
 * names a file it can't take.
 */
export async function attachFiles(
  prisma: PrismaClient,
  where: { appId: string; type: string; key: string },
  values: Record<string, unknown>,
  fields: readonly string[],
  refuse: (field: string) => never,
): Promise<Record<string, unknown>> {
  const out = { ...values };
  for (const field of fields) {
    const value = values[field];
    const id = typeof value === "string" ? value : value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
    if (typeof id !== "string") continue;
    const row = await prisma.appFile.findFirst({ where: { appFileId: id, appId: where.appId, type: where.type, field } }).catch(() => null);
    if (!row || (row.key !== null && row.key !== where.key)) refuse(field);
    if (row.key === null) await prisma.appFile.update({ where: { appFileId: id }, data: { key: where.key } });
    out[field] = entityFileOf(row);
  }
  return out;
}

/** After a save: the entity's files that none of `held` (what pipelines wrote, what the user set) names any more go. */
export async function releaseFiles(prisma: PrismaClient, root: string, where: { appId: string; type: string; key: string }, ...held: unknown[]): Promise<void> {
  const keep = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const id = (value as { id?: unknown }).id;
      if (typeof id === "string") keep.add(id);
      Object.values(value).forEach(collect);
    }
  };
  held.forEach(collect);
  const rows = await prisma.appFile.findMany({ where });
  await dropFiles(prisma, root, rows.filter((r) => !keep.has(r.appFileId)));
}

/** Rows and their files, gone. */
export async function dropFiles(prisma: PrismaClient, root: string, rows: AppFile[]): Promise<void> {
  if (rows.length === 0) return;
  await prisma.appFile.deleteMany({ where: { appFileId: { in: rows.map((r) => r.appFileId) } } });
  for (const row of rows) await removeStored(root, [row.path, row.thumbPath]).catch(() => undefined);
}

/** Files recorded but never attached, older than `ms` (an upload whose form wasn't saved, a run that didn't save). */
export async function sweepFiles(prisma: PrismaClient, root: string, appId: string, ms = 24 * 3_600_000): Promise<void> {
  await dropFiles(prisma, root, await prisma.appFile.findMany({ where: { appId, key: null, dateCreated: { lt: new Date(Date.now() - ms) } } }));
}
