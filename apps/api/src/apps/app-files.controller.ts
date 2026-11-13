import { type FileRef } from "@realentity/storm-shared";
import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, StreamableFile, UploadedFile as Uploaded, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { type UploadedFile } from "../documents/documents.service";
import { AppFilesService } from "./app-files.service";

/** Above DOWNLOAD_MAX_MB's maximum; the service checks the configured limit. */
const MAX_UPLOAD = 500 * 1_048_576;

/** M46: an entity's files and images: uploaded on its form, then downloaded or shown. */
@Controller()
export class AppFilesController {
  constructor(private readonly files: AppFilesService) {}

  /** multipart/form-data: `type`, `field` and `file`; attached to the entity when its form is saved. */
  @Post("apps/:appId/files")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body("type") type: unknown,
    @Body("field") field: unknown,
    @Uploaded() file: UploadedFile | undefined,
  ): Promise<FileRef> {
    return this.files.upload(user.userId, appId, typeof type === "string" ? type : "", typeof field === "string" ? field : "", file);
  }

  /** An image is shown (PNG, JPEG, WebP, GIF: never SVG); any other file is a download. Never run in this origin. */
  @Get("app-files/:fileId")
  @Header("Content-Security-Policy", "sandbox")
  @Header("X-Content-Type-Options", "nosniff")
  async file(@CurrentUser() user: AuthenticatedUser, @Param("fileId", ParseUUIDPipe) fileId: string): Promise<StreamableFile> {
    return this.stream(await this.files.file(user.userId, fileId, false));
  }

  @Get("app-files/:fileId/thumb")
  @Header("Content-Security-Policy", "sandbox")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Cache-Control", "private, max-age=86400")
  async thumb(@CurrentUser() user: AuthenticatedUser, @Param("fileId", ParseUUIDPipe) fileId: string): Promise<StreamableFile> {
    return this.stream(await this.files.file(user.userId, fileId, true));
  }

  private stream(file: Awaited<ReturnType<AppFilesService["file"]>>): StreamableFile {
    const name = file.name.replace(/[^\w.-]/g, "_");
    return new StreamableFile(file.stream, {
      type: file.mime,
      length: file.size,
      disposition: `${file.image ? "inline" : "attachment"}; filename="${name}"`,
    });
  }
}
