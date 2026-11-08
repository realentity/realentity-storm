import { type Document } from "@realentity/storm-db";
import { DOCUMENT_NAME_PATTERN, type DocumentView, type ServerEnv } from "@realentity/storm-shared";
import { BadRequestException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

/** What a form may attach, by content (magic bytes), not by the name or the browser's word. */
const TYPES: { mime: string; extensions: string[]; matches: (head: Buffer) => boolean }[] = [
  { mime: "application/pdf", extensions: [".pdf"], matches: (h) => h.subarray(0, 5).toString("latin1") === "%PDF-" },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    matches: (h) => h.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  },
  { mime: "application/vnd.oasis.opendocument.text", extensions: [".odt"], matches: (h) => h.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
];

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * My documents (M10): my CV and the cover letters I attach to applications, under DOCUMENTS_DIR. The api writes
 * them; the worker only reads them and attaches one only as approved (by id and SHA-256). Uploading under a name in
 * use replaces it: the older row and file stay, so a payload approved before still names the exact file it had.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async list(userId: string): Promise<DocumentView[]> {
    const rows = await this.prisma.client.document.findMany({ where: { userId, replacedAt: null }, orderBy: { name: "asc" } });
    return rows.map(documentView);
  }

  async upload(userId: string, name: string, file: UploadedFile | undefined): Promise<DocumentView> {
    if (!DOCUMENT_NAME_PATTERN.test(name)) throw new BadRequestException('A document name is lowercase letters, digits, ".", "_" or "-", e.g. "cv-main"');
    if (!file || file.size === 0) throw new BadRequestException("No file, or an empty one");
    if (file.size > this.env.DOWNLOAD_MAX_MB * 1_048_576) throw new PayloadTooLargeException(`Larger than ${this.env.DOWNLOAD_MAX_MB} MB`);
    const filename = safeName(file.originalname);
    const extension = extname(filename).toLowerCase();
    const type = TYPES.find((t) => t.extensions.includes(extension));
    if (!type) throw new BadRequestException("Only PDF, DOCX or ODT documents");
    if (!type.matches(file.buffer.subarray(0, 8))) throw new BadRequestException(`Its content isn't a ${extension} file`);

    const documentId = randomUUID();
    const path = `${documentId}${extension}`;
    const root = resolve(this.env.DOCUMENTS_DIR);
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, path), file.buffer, { mode: 0o640 });
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const [, created] = await this.prisma.client.$transaction([
      this.prisma.client.document.updateMany({ where: { userId, name, replacedAt: null }, data: { replacedAt: new Date() } }),
      this.prisma.client.document.create({ data: { documentId, userId, name, filename, mime: type.mime, size: file.size, sha256, path } }),
    ]);
    return documentView(created);
  }

  /** No longer offered to forms; the file stays for proposals approved with it. */
  async remove(userId: string, name: string): Promise<void> {
    const updated = await this.prisma.client.document.updateMany({ where: { userId, name, replacedAt: null }, data: { replacedAt: new Date() } });
    if (updated.count === 0) throw new NotFoundException();
  }

  /** Any version I own: an approved payload may name one that was replaced since. */
  async file(userId: string, documentId: string): Promise<{ stream: ReadStream; mime: string; name: string; size: number }> {
    const document = await this.prisma.client.document.findFirst({ where: { documentId, userId } });
    if (!document) throw new NotFoundException();
    const root = resolve(this.env.DOCUMENTS_DIR);
    const path = resolve(root, document.path);
    const inside = relative(root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new NotFoundException();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException("The file is gone");
    return { stream: createReadStream(path), mime: document.mime, name: document.filename, size: info.size };
  }
}

function documentView(row: Document): DocumentView {
  return {
    documentId: row.documentId,
    name: row.name,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    dateCreated: row.dateCreated.toISOString(),
  };
}

/** The name a form will see: no path, no control characters, at most 120 characters. */
function safeName(name: string): string {
  const base = [...(name.split(/[/\\]/).pop() ?? "")]
    .filter((c) => c.charCodeAt(0) >= 0x20 && !'"<>|:*?'.includes(c))
    .join("")
    .trim();
  return (base || "document").slice(-120);
}
