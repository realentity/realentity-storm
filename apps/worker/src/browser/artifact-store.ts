import { type PrismaClient } from "@ai-me/db";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ArtifactOwner {
  userId: string;
  runId: string;
  stepKey: string;
  itemIndex: number | null;
}

/**
 * Files a run produces (README §6, §9): screenshots, traces, accepted downloads. Stored under ARTIFACTS_DIR by run,
 * each with an Artifact row (kind, size, SHA-256); the api serves them to me only.
 */
export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async save(prisma: PrismaClient, owner: ArtifactOwner, kind: string, content: Buffer, extension: string, mime: string): Promise<string> {
    const relative = join(
      owner.runId,
      `${owner.stepKey}${owner.itemIndex === null ? "" : `-${owner.itemIndex + 1}`}-${kind}-${randomUUID().slice(0, 8)}.${extension}`,
    );
    const path = join(this.root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
    return this.record(prisma, owner, kind, relative, content, mime);
  }

  /** Moves a file in (from quarantine) instead of writing it. */
  async adopt(
    prisma: PrismaClient,
    owner: ArtifactOwner,
    kind: string,
    from: string,
    name: string,
    mime: string,
    content: Buffer,
  ): Promise<string> {
    const relative = join(owner.runId, `${owner.stepKey}-${randomUUID().slice(0, 8)}-${name}`);
    const path = join(this.root, relative);
    await mkdir(dirname(path), { recursive: true });
    await rename(from, path).catch(async () => {
      await writeFile(path, content, { mode: 0o600 });
      await rm(from, { force: true });
    });
    return this.record(prisma, owner, kind, relative, content, mime);
  }

  /**
   * Deletes run files made before `before` (rows and files; a run's folder goes with its last file), in batches, and
   * returns how many. A file already gone counts too: its row is what the run page lists.
   */
  async prune(prisma: PrismaClient, before: Date): Promise<number> {
    let pruned = 0;
    for (;;) {
      const batch = await prisma.artifact.findMany({ where: { dateCreated: { lt: before } }, select: { artifactId: true, path: true }, take: 500 });
      if (batch.length === 0) return pruned;
      for (const artifact of batch) {
        const path = resolve(this.root, artifact.path);
        if (path.startsWith(this.root)) await rm(path, { force: true });
        await rmdir(dirname(path)).catch(() => undefined);
      }
      await prisma.artifact.deleteMany({ where: { artifactId: { in: batch.map((a) => a.artifactId) } } });
      pruned += batch.length;
    }
  }

  /** A download of mine (file.read): its row and content, only from inside ARTIFACTS_DIR. */
  async readDownload(prisma: PrismaClient, userId: string, artifactId: string): Promise<{ name: string; mime: string; sha256: string; content: Buffer }> {
    const artifact = await prisma.artifact.findFirst({ where: { artifactId, userId, kind: "download" } });
    if (!artifact) throw new Error(`There is no download ${artifactId}`);
    const path = resolve(this.root, artifact.path);
    if (!path.startsWith(this.root)) throw new Error(`The download ${artifactId} is outside the artifacts folder`);
    const content = await readFile(path);
    return { name: artifact.path.split("/").pop() ?? artifactId, mime: artifact.mime ?? "application/octet-stream", sha256: artifact.sha256 ?? "", content };
  }

  /** Where a run's downloads wait for their checks; never served. */
  quarantineDir(runId: string): string {
    return join(this.root, ".quarantine", runId);
  }

  async sizeOf(path: string): Promise<number> {
    return (await stat(path)).size;
  }

  private async record(
    prisma: PrismaClient,
    owner: ArtifactOwner,
    kind: string,
    relative: string,
    content: Buffer,
    mime: string,
  ): Promise<string> {
    const artifact = await prisma.artifact.create({
      data: {
        userId: owner.userId,
        runId: owner.runId,
        stepKey: owner.stepKey,
        itemIndex: owner.itemIndex,
        kind,
        path: relative.split("\\").join("/"),
        mime,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    });
    return artifact.artifactId;
  }
}
