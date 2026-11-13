import { attachFiles, dropFiles, FileProblem, IMAGE_MIMES, insideRoot, recordFile, releaseFiles, storeFile, sweepFiles } from "@realentity/storm-files";
import { FILE_KINDS, readAppSource, type AppDefinition, type FileRef, type ServerEnv } from "@realentity/storm-shared";
import { BadRequestException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { type UploadedFile } from "../documents/documents.service";

/**
 * M46: the files and images of entities' fields. Uploaded on the form first (unsaved: no entity yet), then attached
 * when the form is saved: the entity keeps { id, name, mime, size }, never the bytes. Checked and stored by
 * @realentity/storm-files (by content, never by the name or the browser's word), an image with a WebP thumbnail. A
 * file replaced or cleared on the form, or whose entity or App is deleted, goes with it.
 */
@Injectable()
export class AppFilesService {
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
    const stored = await storeFile(this.env.DOCUMENTS_DIR, file.buffer, file.originalname, field.type as "file" | "image").catch((error: unknown) => {
      throw error instanceof FileProblem ? new BadRequestException(error.message) : error;
    });
    const ref = await recordFile(this.prisma.client, appId, typeName, fieldName, stored);
    await sweepFiles(this.prisma.client, this.env.DOCUMENTS_DIR, appId);
    return ref;
  }

  /**
   * The form's file ids swapped for their references, each checked to be an upload to this App, type and field
   * (unsaved, or already this entity's); the uploads are then the entity's.
   */
  attach(appId: string, typeName: string, key: string, values: Record<string, unknown>, fileFields: string[]): Promise<Record<string, unknown>> {
    return attachFiles(this.prisma.client, { appId, type: typeName, key }, values, fileFields, (field) => {
      throw new BadRequestException({ message: "Some values can't be saved", errors: [{ path: field, message: "isn't a file uploaded to this field" }] });
    });
  }

  /** After a save: the entity's files its values no longer name (replaced or cleared on the form) go. */
  release(appId: string, typeName: string, key: string, ...held: unknown[]): Promise<void> {
    return releaseFiles(this.prisma.client, this.env.DOCUMENTS_DIR, { appId, type: typeName, key }, ...held);
  }

  /** Every file of an entity, gone with it. */
  async removeEntity(appId: string, typeName: string, key: string): Promise<void> {
    await dropFiles(this.prisma.client, this.env.DOCUMENTS_DIR, await this.prisma.client.appFile.findMany({ where: { appId, type: typeName, key } }));
  }

  /** Every file of an App, before it is deleted (its rows go with it, the files on disk here). */
  async removeApp(appId: string): Promise<void> {
    await dropFiles(this.prisma.client, this.env.DOCUMENTS_DIR, await this.prisma.client.appFile.findMany({ where: { appId } }));
  }

  async file(userId: string, appFileId: string, thumb: boolean): Promise<{ stream: ReadStream; mime: string; name: string; size: number; image: boolean }> {
    const row = await this.prisma.client.appFile.findFirst({ where: { appFileId, app: { userId } } });
    const path = thumb ? row?.thumbPath : row?.path;
    if (!row || !path) throw new NotFoundException();
    const full = insideRoot(this.env.DOCUMENTS_DIR, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException("The file is gone");
    const image = thumb || IMAGE_MIMES.includes(row.mime);
    return { stream: createReadStream(full), mime: thumb ? "image/webp" : row.mime, name: row.filename, size: info.size, image };
  }

  private async definition(userId: string, appId: string): Promise<AppDefinition> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } }) : null;
    if (!app || !version) throw new NotFoundException();
    return readAppSource(version.source);
  }
}
