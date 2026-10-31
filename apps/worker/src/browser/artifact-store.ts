import { type PrismaClient } from "@ai-me/db";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
