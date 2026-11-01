import { type PrismaClient } from "@ai-me/db";
import { type FormFile } from "@ai-me/steps";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * My documents (Documents page) for forms to attach, read-only here: the api stores them under DOCUMENTS_DIR. A
 * document is attached only as the exact file approved: its row and its SHA-256 must both match.
 */
export class DocumentStore {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** The current document with this name, as a payload's file entry for `key`. */
  async attach(prisma: PrismaClient, userId: string, name: string, key: string): Promise<FormFile> {
    const document = await prisma.document.findFirst({ where: { userId, name, replacedAt: null }, orderBy: { dateCreated: "desc" } });
    if (!document) throw new Error(`There is no document "${name}": upload it on the Documents page`);
    return { key, document: name, documentId: document.documentId, sha256: document.sha256, filename: document.filename };
  }

  /** The current document with this name and its content (file.read), checked against its SHA-256. */
  async read(prisma: PrismaClient, userId: string, name: string): Promise<{ file: FormFile; mimeType: string; buffer: Buffer }> {
    const file = await this.attach(prisma, userId, name, "-");
    const { mimeType, buffer } = await this.approvedFile(prisma, userId, file);
    return { file, mimeType, buffer };
  }

  /** The approved file, checked (the same document, the same content), as the form gets it: under its own name. */
  async approvedFile(prisma: PrismaClient, userId: string, file: FormFile): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
    const document = await prisma.document.findFirst({ where: { documentId: file.documentId, userId } });
    if (!document || document.sha256 !== file.sha256) throw new Error(`The document "${file.document}" isn't the one I approved`);
    const path = resolve(this.root, document.path);
    const inside = relative(this.root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`The document "${file.document}" is outside the documents folder`);
    const content = await readFile(path);
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error(`The file of "${file.document}" changed on disk since I approved it`);
    }
    return { name: document.filename, mimeType: document.mime, buffer: content };
  }
}
