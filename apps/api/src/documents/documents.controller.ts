import { type DocumentView } from "@ai-me/shared";
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
  UploadedFile as Uploaded,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { DocumentsService, type UploadedFile } from "./documents.service";

/** Above DOWNLOAD_MAX_MB's maximum; the service checks the configured limit. */
const MAX_UPLOAD = 500 * 1_048_576;

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<DocumentView[]> {
    return this.documents.list(user.userId);
  }

  /** multipart/form-data: `name` and `file`. */
  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Body("name") name: unknown,
    @Uploaded() file: UploadedFile | undefined,
  ): Promise<DocumentView> {
    return this.documents.upload(user.userId, typeof name === "string" ? name.trim() : "", file);
  }

  @Delete(":name")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("name") name: string): Promise<void> {
    return this.documents.remove(user.userId, name);
  }

  /** Always a download: a document is not to open in this origin. */
  @Get(":documentId/file")
  @Header("Content-Security-Policy", "sandbox")
  @Header("X-Content-Type-Options", "nosniff")
  async file(@CurrentUser() user: AuthenticatedUser, @Param("documentId", ParseUUIDPipe) documentId: string): Promise<StreamableFile> {
    const file = await this.documents.file(user.userId, documentId);
    return new StreamableFile(file.stream, {
      type: file.mime,
      length: file.size,
      disposition: `attachment; filename="${file.name.replace(/[^\w.-]/g, "_")}"`,
    });
  }
}
