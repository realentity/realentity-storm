import { type CredentialVault } from "../secrets/credential-vault";

/** The only host a GitHub source talks to (M43-T1): a source's token is opened for it alone. */
export const GITHUB_API = "api.github.com";

/** A file's text at most: larger ones (generated, vendored) aren't documents to index. */
export const FILE_BYTES = 300_000;

export interface Commit {
  sha: string;
  date: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed";
}

/**
 * GitHub's REST API, read-only (M43-T1, docs/design.md §8.1): a branch's head, the files changed between two commits,
 * a commit's files, a file's text. A private repository's token comes from the vault for api.github.com only; it never
 * appears in an error.
 */
export class GitHubClient {
  constructor(
    private readonly vault: CredentialVault | undefined,
    private readonly send: typeof fetch = fetch,
  ) {}

  /** The branch's newest commit (null: the repository's default branch). */
  async head(userId: string, source: GitHubSource): Promise<Commit> {
    const body = (await this.json(userId, source, `/repos/${source.repo}/commits/${encodeURIComponent(source.branch ?? "HEAD")}`)) as {
      sha: string;
      commit: { committer?: { date?: string }; author?: { date?: string } };
    };
    return { sha: body.sha, date: body.commit.committer?.date ?? body.commit.author?.date ?? new Date().toISOString() };
  }

  /** The files changed from `base` to `head`; a rename is the old path removed and the new one added. */
  async changed(userId: string, source: GitHubSource, base: string, head: string): Promise<ChangedFile[]> {
    const body = (await this.json(userId, source, `/repos/${source.repo}/compare/${base}...${head}`)) as {
      files?: { filename: string; status: string; previous_filename?: string }[];
    };
    return (body.files ?? []).flatMap((f): ChangedFile[] => {
      if (f.status === "removed") return [{ path: f.filename, status: "removed" }];
      if (f.status === "renamed" && f.previous_filename)
        return [
          { path: f.previous_filename, status: "removed" },
          { path: f.filename, status: "added" },
        ];
      return [{ path: f.filename, status: f.status === "added" ? "added" : "modified" }];
    });
  }

  /** Every file of a commit, with its size. */
  async files(userId: string, source: GitHubSource, sha: string): Promise<{ path: string; size: number }[]> {
    const body = (await this.json(userId, source, `/repos/${source.repo}/git/trees/${sha}?recursive=1`)) as {
      tree?: { path: string; type: string; size?: number }[];
      truncated?: boolean;
    };
    if (body.truncated) throw new Error(`${source.repo} has too many files to list at once: narrow the source's path`);
    return (body.tree ?? []).filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size ?? 0 }));
  }

  /** A file's text at a commit; null when it is too large. */
  async text(userId: string, source: GitHubSource, path: string, sha: string): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(
      userId,
      source,
      `/repos/${source.repo}/contents/${encoded}?ref=${sha}`,
      "application/vnd.github.raw+json",
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > FILE_BYTES ? null : bytes.toString("utf8");
  }

  private async json(userId: string, source: GitHubSource, path: string): Promise<unknown> {
    return (await this.request(userId, source, path, "application/vnd.github+json")).json();
  }

  private async request(userId: string, source: GitHubSource, path: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = { accept, "x-github-api-version": "2022-11-28", "user-agent": "realentity-storm" };
    if (source.credential) {
      if (!this.vault) throw new Error("No credentials here");
      // Refused unless the credential's allowedHosts has api.github.com.
      const { secret } = await this.vault.revealOwn(userId, source.credential, GITHUB_API);
      headers.authorization = `Bearer ${secret}`;
    }
    let response: Response;
    try {
      response = await this.send(`https://${GITHUB_API}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`GitHub could not be reached for ${source.repo}`);
    }
    if (response.ok) return response;
    const why =
      response.status === 404
        ? "not found (a private repository needs a token with read access)"
        : response.status === 401 || response.status === 403
          ? "access refused (the token, or GitHub's rate limit)"
          : `answered ${response.status}`;
    throw new Error(`GitHub: ${source.repo} ${why}`);
  }
}

export interface GitHubSource {
  repo: string;
  branch: string | null;
  credential: string | null;
}
