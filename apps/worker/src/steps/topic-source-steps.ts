import { type PrismaClient, type TopicSource } from "@realentity/storm-db";
import { type Embeddings } from "@realentity/storm-llm";
import { isTextFile, pathMatches } from "@realentity/storm-shared";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { passagesOf } from "../sources/chunk";
import { FILE_BYTES, type ChangedFile, type GitHubClient } from "../sources/github";

/** Files one read of a source takes at most: a larger first read needs a narrower path. */
const MAX_FILES = 500;
/** A changed file's text handed on (to topic.extract), at most. */
const FILE_TEXT = 20_000;
/** Passages embedded per call. */
const EMBED_BATCH = 64;

export interface SourceChange {
  topic: string;
  topicId: string;
  sourceId: string;
  repo: string;
  path: string;
  status: ChangedFile["status"];
  commit: string;
  commitDate: string;
  url: string;
}

export interface SourceRead {
  sourceId: string;
  topic: string;
  repo: string;
  /** The commit read before; null: the first read (or the old one is gone), so every file under the path. */
  from: string | null;
  to: string;
  date: string;
}

/**
 * git.changes (M43-T1, docs/design.md §8.1): the files under each GitHub source's path changed since it was last
 * indexed, at its branch's head. Seeing that nothing changed is one API call, no LLM. Reads only: topic.index moves a
 * source on once its files are indexed, so a failed index is read again next time.
 */
export class GitChangesStep implements StepExecutor {
  readonly type = "git.changes";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GitHubClient,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { topics: only } = input as { topics?: string[] };
    const sources = await this.prisma.topicSource.findMany({
      where: { userId: context.userId, kind: "GITHUB", topic: { status: "ACTIVE", ...(only?.length ? { name: { in: only } } : {}) } },
      include: { topic: true },
      orderBy: { dateCreated: "asc" },
    });
    const changes: SourceChange[] = [];
    const reads: SourceRead[] = [];
    const problems: string[] = [];
    for (const source of sources) {
      try {
        const { files, read } = await this.read(context.userId, source);
        reads.push(read);
        changes.push(
          ...files.map((f) => ({
            topic: source.topic.name,
            topicId: source.topicId,
            sourceId: source.topicSourceId,
            repo: source.location,
            path: f.path,
            status: f.status,
            commit: read.to,
            commitDate: read.date,
            url: `https://github.com/${source.location}/blob/${read.to}/${f.path}`,
          })),
        );
      } catch (error) {
        problems.push(`${source.topic.name}, ${source.location}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { changes, sources: reads, problems };
  }

  private async read(
    userId: string,
    source: TopicSource & { topic: { name: string } },
  ): Promise<{ files: ChangedFile[]; read: SourceRead }> {
    const gh = { repo: source.location, branch: source.branch, credential: source.credential };
    const head = await this.github.head(userId, gh);
    const read = {
      sourceId: source.topicSourceId,
      topic: source.topic.name,
      repo: source.location,
      from: source.cursor,
      to: head.sha,
      date: head.date,
    };
    if (source.cursor === head.sha) return { files: [], read };
    const wanted = (path: string) => pathMatches(source.path, path) && isTextFile(path);
    let files: ChangedFile[];
    if (source.cursor) {
      try {
        files = (await this.github.changed(userId, gh, source.cursor, head.sha)).filter((f) => wanted(f.path));
      } catch {
        // The commit read last is gone (a force push): read everything again.
        return this.everything(userId, source, gh, { ...read, from: null }, wanted);
      }
    } else return this.everything(userId, source, gh, read, wanted);
    if (files.length > MAX_FILES) throw new Error(`${files.length} files changed under ${source.path}: more than ${MAX_FILES} at once`);
    return { files, read };
  }

  private async everything(
    userId: string,
    source: TopicSource,
    gh: { repo: string; branch: string | null; credential: string | null },
    read: SourceRead,
    wanted: (path: string) => boolean,
  ): Promise<{ files: ChangedFile[]; read: SourceRead }> {
    const files = (await this.github.files(userId, gh, read.to))
      .filter((f) => wanted(f.path) && f.size <= FILE_BYTES)
      .map((f): ChangedFile => ({ path: f.path, status: "added" }));
    if (files.length > MAX_FILES) throw new Error(`${files.length} files under ${source.path}: more than ${MAX_FILES}; narrow the path`);
    return { files, read: { ...read, from: null } };
  }
}

/**
 * topic.index (M43-T3): the passages of git.changes' files, each with its path, commit and (with an embeddings
 * provider) its embedding; a removed file's passages go. Then each source is marked read at its commit. The index is a
 * cache: deleted, the next read rebuilds the same passages. `files` hands the changed files' text on to topic.extract.
 * A dry run reads the files and writes nothing.
 */
export class TopicIndexStep implements StepExecutor {
  readonly type = "topic.index";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GitHubClient,
    private readonly embeddings: Embeddings | null,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { changes, sources: reads } = input as { changes: SourceChange[]; sources: SourceRead[] };
    const { userId } = context;
    const ids = [...new Set([...changes.map((c) => c.sourceId), ...reads.map((r) => r.sourceId)])];
    const sources = new Map(
      (await this.prisma.topicSource.findMany({ where: { userId, topicSourceId: { in: ids } } })).map((s) => [s.topicSourceId, s]),
    );
    const files: (SourceChange & { text: string; firstRead: boolean })[] = [];
    const firstRead = (sourceId: string) => reads.find((r) => r.sourceId === sourceId)?.from === null;
    const problems: string[] = [];
    let passages = 0;
    let removed = 0;
    const failed = new Set<string>();

    for (const change of changes) {
      const source = sources.get(change.sourceId);
      // Only the user's own sources, and only the commit git.changes read.
      if (!source || reads.find((r) => r.sourceId === change.sourceId)?.to !== change.commit) continue;
      try {
        if (change.status === "removed") {
          if (!context.dryRun) removed += await this.forget(source.topicSourceId, change.path);
          files.push({ ...change, text: "", firstRead: firstRead(change.sourceId) });
          continue;
        }
        const text = await this.github.text(
          userId,
          { repo: source.location, branch: source.branch, credential: source.credential },
          change.path,
          change.commit,
        );
        if (text === null) {
          problems.push(`${change.path}: too large to index`);
          continue;
        }
        files.push({ ...change, text: text.slice(0, FILE_TEXT), firstRead: firstRead(change.sourceId) });
        if (!context.dryRun) passages += await this.keep(source, change, text, context);
      } catch (error) {
        failed.add(change.sourceId);
        problems.push(`${change.repo} ${change.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!context.dryRun) {
      for (const read of reads) {
        const source = sources.get(read.sourceId);
        // A source with a file that failed stays where it was: the next read takes its changes again.
        if (!source || failed.has(read.sourceId)) continue;
        if (read.from === null) {
          // Everything was read: passages of files no longer under the path go.
          const present = changes.filter((c) => c.sourceId === read.sourceId).map((c) => c.path);
          removed += (await this.prisma.topicPassage.deleteMany({ where: { topicSourceId: read.sourceId, path: { notIn: present } } }))
            .count;
        }
        await this.prisma.topicSource.update({ where: { topicSourceId: read.sourceId }, data: { cursor: read.to, readAt: new Date() } });
      }
    }
    return { files, passages, removed, problems };
  }

  private async forget(topicSourceId: string, path: string): Promise<number> {
    return (await this.prisma.topicPassage.deleteMany({ where: { topicSourceId, path } })).count;
  }

  /** A file's passages instead of the ones it had. */
  private async keep(source: TopicSource, change: SourceChange, text: string, context: StepContext): Promise<number> {
    const pieces = passagesOf(text);
    const vectors: (number[] | null)[] = pieces.map(() => null);
    if (this.embeddings && pieces.length) {
      for (let start = 0; start < pieces.length; start += EMBED_BATCH) {
        const batch = pieces.slice(start, start + EMBED_BATCH);
        try {
          const { vectors: made, usage } = await this.embeddings.embed(batch.map((p) => `${change.path}\n${p.heading}\n\n${p.text}`));
          context.recordUsage(usage);
          made.forEach((v, i) => (vectors[start + i] = v));
        } catch {
          // Without vectors the passages are still found by their words.
        }
      }
    }
    const model = this.embeddings?.model ?? null;
    await this.prisma.$transaction([
      this.prisma.topicPassage.deleteMany({ where: { topicSourceId: source.topicSourceId, path: change.path } }),
      ...pieces.map(
        (p, ordinal) => this.prisma.$executeRaw`
          INSERT INTO "TopicPassages" ("topicPassageId", "userId", "topicId", "topicSourceId", "path", "ref", "refDate", "heading", "ordinal", "text", "embedding", "embeddingModel")
          VALUES (gen_random_uuid(), ${source.userId}::uuid, ${source.topicId}::uuid, ${source.topicSourceId}::uuid, ${change.path}, ${change.commit},
                  ${new Date(change.commitDate)}, ${p.heading}, ${ordinal}, ${p.text},
                  ${vectors[ordinal] ? `[${vectors[ordinal].join(",")}]` : null}::vector, ${vectors[ordinal] ? model : null})`,
      ),
    ]);
    return pieces.length;
  }
}
