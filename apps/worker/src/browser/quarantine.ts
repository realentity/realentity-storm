import { type PrismaClient } from "@realentity/storm-db";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type Download } from "playwright";
import { type ArtifactOwner, type ArtifactStore } from "./artifact-store";

/** File types a download may be, by content (magic bytes), not by its name or the server's word. */
const TYPES: { mime: string; extensions: string[]; matches: (head: Buffer) => boolean }[] = [
  { mime: "application/pdf", extensions: [".pdf"], matches: (h) => h.subarray(0, 5).toString("latin1") === "%PDF-" },
  {
    mime: "image/png",
    extensions: [".png"],
    matches: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: "image/jpeg", extensions: [".jpg", ".jpeg"], matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  // Office documents are zip archives; only their own extensions, never a bare .zip.
  {
    mime: "application/vnd.openxmlformats-officedocument",
    extensions: [".docx", ".xlsx", ".pptx", ".odt"],
    matches: (h) => h.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  },
  { mime: "text/plain", extensions: [".txt", ".csv", ".md", ".json"], matches: (h) => isText(h) },
];

export type QuarantineResult =
  { accepted: true; artifactId: string; name: string; mime: string; size: number } | { accepted: false; name: string; reason: string };

/**
 * Downloads land in quarantine first (README §6, M8-T9): a run's own folder that is never served. A download is
 * accepted only when its size is within DOWNLOAD_MAX_MB and its content is one of the allowed types matching its
 * extension; then it moves to the run's artifacts. Anything else is deleted.
 */
export class Quarantine {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly artifacts: ArtifactStore,
    private readonly maxBytes: number,
  ) {}

  async accept(download: Download, owner: ArtifactOwner): Promise<QuarantineResult> {
    const name = safeName(download.suggestedFilename());
    const dir = this.artifacts.quarantineDir(owner.runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${name}`);
    try {
      await download.saveAs(path);
      const size = await this.artifacts.sizeOf(path);
      if (size > this.maxBytes) {
        const limit = this.maxBytes >= 1_048_576 ? `${Math.round(this.maxBytes / 1_048_576)} MB` : `${Math.round(this.maxBytes / 1024)} KB`;
        return this.reject(path, name, `larger than ${limit}`);
      }
      if (size === 0) return this.reject(path, name, "empty");
      const content = await readFile(path);
      const type = TYPES.find((t) => t.extensions.includes(extname(name).toLowerCase()));
      if (!type) return this.reject(path, name, `the type ${extname(name) || "(none)"} isn't allowed`);
      if (!type.matches(content.subarray(0, 512))) return this.reject(path, name, `its content isn't a ${extname(name)} file`);
      const artifactId = await this.artifacts.adopt(this.prisma, owner, "download", path, name, type.mime, content);
      return { accepted: true, artifactId, name, mime: type.mime, size };
    } catch (error) {
      return this.reject(path, name, error instanceof Error ? error.message : String(error));
    }
  }

  private async reject(path: string, name: string, reason: string): Promise<QuarantineResult> {
    await rm(path, { force: true });
    return { accepted: false, name, reason };
  }
}

/** A file name without folders or odd characters. */
export function safeName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, "/"))
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "download";
}

function isText(head: Buffer): boolean {
  if (head.length === 0 || head.includes(0)) return false;
  // Valid printable UTF-8: invalid bytes decode to U+FFFD, which isn't allowed; the last character may be cut in
  // the middle at the 512-byte boundary.
  const chars = [...head.toString("utf8")];
  if (chars.at(-1)?.codePointAt(0) === 0xfffd) chars.pop();
  return chars.every((c) => {
    const code = c.codePointAt(0) ?? 0;
    return (code >= 0x20 && code <= 0x7e) || [0x09, 0x0a, 0x0b, 0x0c, 0x0d].includes(code) || (code >= 0xa0 && code !== 0xfffd);
  });
}
