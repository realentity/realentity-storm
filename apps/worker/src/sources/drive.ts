import { isTextFile } from "@realentity/storm-shared";
import { type GoogleConnection } from "../google/google-connection";
import { textOf } from "../steps/file-steps";

/** Google's own formats, read as text by exporting them. */
const DOC = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";
export const FOLDER = "application/vnd.google-apps.folder";
const EXPORTS: Record<string, string> = { [DOC]: "text/markdown", [SLIDES]: "text/plain" };

/** A text file's size at most; a PDF's (larger ones are scans or books, not documents to index). */
const TEXT_BYTES = 300_000;
const PDF_BYTES = 20 * 1_048_576;
/** A folder's files listed at most, subfolders included. */
export const MAX_DRIVE_FILES = 500;
/** How deep a file's folders are followed up, looking for a source's folder. */
const MAX_DEPTH = 30;

const FILE_FIELDS = "id,name,mimeType,parents,trashed,modifiedTime,version,size,webViewLink";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  modifiedTime?: string;
  version?: string;
  size?: string;
  webViewLink?: string;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
}

/** What Storm reads in a folder: Google Docs and Slides (exported), PDFs and text files. */
export function readableDriveFile(file: Pick<DriveFile, "name" | "mimeType">): boolean {
  return file.mimeType in EXPORTS || file.mimeType === "application/pdf" || file.mimeType.startsWith("text/") || isTextFile(file.name);
}

/**
 * Google Drive's API, read-only (M43-T2, docs/design.md §8.1), through the user's Google connection (scope
 * drive.readonly): a folder's files, Drive's changes since a page token, a file's text. Every call names
 * supportsAllDrives, so a shared drive's folder works like one in My Drive.
 */
export class DriveClient {
  constructor(private readonly google: GoogleConnection) {}

  /** Where Drive's changes start now: read before a first listing, so what changes during it comes next time. */
  async startToken(userId: string): Promise<string> {
    const body = await this.json<{ startPageToken: string }>(userId, "/changes/startPageToken", { supportsAllDrives: "true" });
    return body.startPageToken;
  }

  /** Every change since `token` (all of the user's Drive), and the token to continue from. */
  async changes(userId: string, token: string): Promise<{ changes: DriveChange[]; next: string }> {
    const changes: DriveChange[] = [];
    let page = token;
    for (;;) {
      const body = await this.json<{ changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(userId, "/changes", {
        pageToken: page,
        pageSize: "1000",
        includeRemoved: "true",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      });
      changes.push(...(body.changes ?? []));
      if (body.newStartPageToken) return { changes, next: body.newStartPageToken };
      if (!body.nextPageToken) throw new Error("Google Drive's changes ended without a token to continue from");
      page = body.nextPageToken;
    }
  }

  async file(userId: string, id: string): Promise<DriveFile> {
    return this.json<DriveFile>(userId, `/files/${encodeURIComponent(id)}`, { fields: FILE_FIELDS, supportsAllDrives: "true" });
  }

  /** The files directly in a folder, not trashed. */
  async children(userId: string, folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let page: string | undefined;
    do {
      const body = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(userId, "/files", {
        q: `'${folderId}' in parents and trashed = false`,
        pageSize: "1000",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        ...(page ? { pageToken: page } : {}),
      });
      files.push(...(body.files ?? []));
      page = body.nextPageToken;
    } while (page);
    return files;
  }

  /** Every file under a folder, its subfolders' too, each with its path from the folder ("Specs/Kickoff"). */
  async everything(userId: string, folderId: string): Promise<{ file: DriveFile; path: string }[]> {
    const found: { file: DriveFile; path: string }[] = [];
    const folders: { id: string; path: string }[] = [{ id: folderId, path: "" }];
    const seen = new Set([folderId]);
    while (folders.length) {
      const folder = folders.shift()!;
      for (const file of await this.children(userId, folder.id)) {
        const path = folder.path ? `${folder.path}/${file.name}` : file.name;
        if (file.mimeType === FOLDER) {
          if (!seen.has(file.id) && folders.length + seen.size < MAX_DRIVE_FILES) {
            seen.add(file.id);
            folders.push({ id: file.id, path });
          }
        } else found.push({ file, path });
        if (found.length > MAX_DRIVE_FILES) throw new Error(`more than ${MAX_DRIVE_FILES} files in the folder; choose a narrower one`);
      }
    }
    return found;
  }

  /**
   * Where a file is under `folderId`: its path ("Specs/Kickoff"), or null when it isn't in that folder (nor in one of
   * its subfolders). `known` keeps the folders looked up, for the other changes of the same read.
   */
  async pathUnder(userId: string, file: DriveFile, folderId: string, known: Map<string, DriveFile | null>): Promise<string | null> {
    const names = [file.name];
    let parents = file.parents ?? [];
    for (let depth = 0; depth < MAX_DEPTH && parents.length; depth++) {
      if (parents.includes(folderId)) return names.reverse().join("/");
      const [parentId] = parents;
      let parent = known.get(parentId);
      if (parent === undefined) {
        parent = await this.file(userId, parentId).catch(() => null);
        known.set(parentId, parent);
      }
      if (!parent) return null;
      names.push(parent.name);
      parents = parent.parents ?? [];
    }
    return null;
  }

  /** A file's text: a Google Doc as Markdown (its headings kept), Slides as text, a PDF's text layer; null when too large. */
  async text(userId: string, file: Pick<DriveFile, "id" | "name" | "mimeType">): Promise<string | null> {
    const id = encodeURIComponent(file.id);
    const exported = EXPORTS[file.mimeType];
    const response = exported
      ? await this.get(userId, `/files/${id}/export`, { mimeType: exported })
      : await this.get(userId, `/files/${id}`, { alt: "media", supportsAllDrives: "true" });
    const bytes = Buffer.from(await response.arrayBuffer());
    const pdf = file.mimeType === "application/pdf";
    if (bytes.length > (pdf ? PDF_BYTES : TEXT_BYTES)) return null;
    return exported ? bytes.toString("utf8") : textOf(file.mimeType, bytes, file.name);
  }

  private async json<T>(userId: string, path: string, query: Record<string, string>): Promise<T> {
    return (await (await this.get(userId, path, query)).json()) as T;
  }

  private async get(userId: string, path: string, query: Record<string, string>): Promise<Response> {
    const url = `${this.google.driveBase}${path}?${new URLSearchParams(query).toString()}`;
    let response: Response;
    try {
      response = await this.google.request(userId, "drive", url, { redirect: "follow" });
    } catch (error) {
      if (error instanceof Error && error.name !== "TypeError") throw error;
      throw new Error("Google Drive could not be reached");
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const why =
      response.status === 404
        ? "not found (or not shared with the connected Google account)"
        : response.status === 403
          ? `refused${body.error?.message ? `: ${body.error.message}` : ""} (is the Drive API on in the Google Cloud project?)`
          : `answered ${response.status}`;
    throw new Error(`Google Drive: ${why}`);
  }
}
