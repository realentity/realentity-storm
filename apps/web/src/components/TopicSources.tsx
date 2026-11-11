import { type TopicSourceView } from "@realentity/storm-shared";
import { IconBrandGithub, IconBrandGoogleDrive, IconPaperclip, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/endpoints";
import { AddCredential, GITHUB_API } from "./AddCredential";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/**
 * A topic's sources (M43, docs/design.md §8.1): where its documents live, linked and never copied. Storm keeps where it
 * read to and passages of the files (a cache): Rebuild deletes them, and the next read makes them again.
 */
export function TopicSources({ topicId }: { topicId: string }) {
  const sources = useLoad(() => api.topics.sources(topicId), [topicId]);
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const run = async (work: () => Promise<unknown>) => {
    if (await action.run(async () => (await work(), true))) sources.reload();
  };
  return (
    <div className="mt-3" data-testid="topic-sources">
      <div className="d-flex align-items-center mb-2">
        <h4 className="mb-0 flex-fill">Sources</h4>
        <button type="button" className="btn btn-sm btn-ghost-primary" onClick={() => setAdding(true)} data-testid="source-add">
          <IconPlus size={16} className="me-1" />
          Add
        </button>
      </div>
      <ErrorAlert error={sources.error ?? action.error} />
      {adding && (
        <SourceForm
          topicId={topicId}
          onDone={(added) => {
            setAdding(false);
            if (added) sources.reload();
          }}
        />
      )}
      {sources.data?.length === 0 && !adding && (
        <p className="text-secondary small">
          None yet. A GitHub repository (its decision records, specs) or a Google Drive folder is read where it is: Storm keeps passages to
          quote, never a copy to keep up to date. The attachments of the topic's emails (PDFs, text files) are added here by topic upkeep.
        </p>
      )}
      {!!sources.data?.length && (
        <div className="list-group">
          {sources.data.map((s) => (
            <SourceRow
              key={s.topicSourceId}
              source={s}
              busy={action.busy}
              onRebuild={() => void run(() => api.topicSources.rebuild(s.topicSourceId))}
              onRemove={() => {
                if (window.confirm(`Remove ${s.title || s.location} from the topic? Its passages go; the facts read from it stay.`)) {
                  void run(() => api.topicSources.remove(s.topicSourceId));
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceRow({
  source,
  busy,
  onRebuild,
  onRemove,
}: {
  source: TopicSourceView;
  busy: boolean;
  onRebuild: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="list-group-item d-flex align-items-center gap-2 py-2" data-testid={`source-${source.location}`}>
      {source.kind === "ATTACHMENT" && <IconPaperclip size={18} className="text-secondary flex-shrink-0" />}
      {source.kind === "GITHUB" && <IconBrandGithub size={18} className="text-secondary flex-shrink-0" />}
      {source.kind === "DRIVE" && <IconBrandGoogleDrive size={18} className="text-secondary flex-shrink-0" />}
      <div className="flex-fill overflow-hidden">
        {source.kind === "ATTACHMENT" ? (
          <div className="text-truncate">
            {source.path} <span className="text-secondary">attached to {source.title}</span>
          </div>
        ) : source.kind === "DRIVE" ? (
          <div className="text-truncate">
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.title || "Drive folder"}
            </a>{" "}
            {source.path !== "**" && <code>{source.path}</code>}
            <span className="text-secondary"> in Google Drive, with its subfolders</span>
          </div>
        ) : (
          <div className="text-truncate">
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.location}
            </a>{" "}
            <code>{source.path}</code>
            {source.branch && <span className="text-secondary"> on {source.branch}</span>}
            {source.credential && <span className="badge bg-secondary-lt ms-2">{source.credential}</span>}
          </div>
        )}
        <div className="small text-secondary">
          {source.kind === "ATTACHMENT"
            ? source.cursor
              ? `${source.passages} passages`
              : "not read yet"
            : source.kind === "DRIVE"
              ? source.cursor
                ? `read ${formatDateTime(source.readAt)} · ${source.passages} passages`
                : "not read yet: the next run of a pipeline with drive.changes reads it"
              : source.cursor
                ? `read at ${source.cursor}${source.readAt ? `, ${formatDateTime(source.readAt)}` : ""} · ${source.passages} passages`
                : "not read yet: the next run of a pipeline with git.changes reads it"}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-sm btn-ghost-secondary"
        title="Rebuild: delete its passages; the next read indexes every file again"
        disabled={busy}
        onClick={onRebuild}
      >
        <IconRefresh size={16} className="me-1" />
        Rebuild
      </button>
      <button type="button" className="btn btn-sm btn-ghost-danger" aria-label="Remove source" disabled={busy} onClick={onRemove}>
        <IconX size={16} />
      </button>
    </div>
  );
}

function SourceForm({ topicId, onDone }: { topicId: string; onDone: (added: boolean) => void }) {
  const credentials = useLoad(() => api.credentials.list(), []);
  const [kind, setKind] = useState<"GITHUB" | "DRIVE">("GITHUB");
  const [location, setLocation] = useState("");
  const [path, setPath] = useState("docs/**");
  const [branch, setBranch] = useState("");
  const [credential, setCredential] = useState("");
  const [addingToken, setAddingToken] = useState(false);
  const action = useAction();
  const forGitHub = credentials.data?.filter((c) => c.allowedHosts.some((h) => h.toLowerCase() === GITHUB_API)) ?? [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const source = kind === "DRIVE" ? { kind, location, path } : { kind, location, path, branch, credential };
    if (await action.run(() => api.topics.addSource(topicId, source))) onDone(true);
  };
  const choose = (next: "GITHUB" | "DRIVE") => {
    setKind(next);
    setLocation("");
    // A repository's documents are usually under docs/; a folder is read whole.
    if (path === "docs/**" || path === "**") setPath(next === "DRIVE" ? "**" : "docs/**");
  };
  return (
    <>
      <form className="card card-body mb-2" onSubmit={(e) => void submit(e)} data-testid="source-form">
        <ErrorAlert error={action.error} title="Not added" />
        <div className="btn-group w-100 mb-2" role="group" aria-label="Where the documents are">
          <button
            type="button"
            className={`btn ${kind === "GITHUB" ? "btn-primary" : ""}`}
            aria-pressed={kind === "GITHUB"}
            onClick={() => choose("GITHUB")}
          >
            <IconBrandGithub size={16} className="me-1" />
            GitHub repository
          </button>
          <button
            type="button"
            className={`btn ${kind === "DRIVE" ? "btn-primary" : ""}`}
            aria-pressed={kind === "DRIVE"}
            onClick={() => choose("DRIVE")}
            data-testid="source-kind-drive"
          >
            <IconBrandGoogleDrive size={16} className="me-1" />
            Google Drive folder
          </button>
        </div>
        {kind === "DRIVE" ? (
          <DriveFields location={location} setLocation={setLocation} path={path} setPath={setPath} />
        ) : (
          <>
            <div className="row g-2">
              <div className="col-sm-5">
                <label className="form-label required" htmlFor="source-location">
                  GitHub repository
                </label>
                <input
                  id="source-location"
                  className="form-control"
                  placeholder="owner/repo"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  required
                />
              </div>
              <div className="col-sm-4">
                <label className="form-label" htmlFor="source-path">
                  Files
                </label>
                <input id="source-path" className="form-control" value={path} onChange={(e) => setPath(e.target.value)} />
              </div>
              <div className="col-sm-3">
                <label className="form-label" htmlFor="source-branch">
                  Branch
                </label>
                <input
                  id="source-branch"
                  className="form-control"
                  placeholder="the default"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </div>
              <div className="col-sm-6">
                <label className="form-label" htmlFor="source-credential">
                  Token
                </label>
                <select id="source-credential" className="form-select" value={credential} onChange={(e) => setCredential(e.target.value)}>
                  <option value="">None: a public repository</option>
                  {forGitHub.map((c) => (
                    <option key={c.credentialId} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="form-hint">
                  A private repository needs a read-only token, kept as a <Link to="/credentials">credential</Link> for {GITHUB_API} only.{" "}
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0 align-baseline"
                    onClick={() => setAddingToken(true)}
                    data-testid="source-new-token"
                  >
                    New GitHub token
                  </button>
                </div>
              </div>
            </div>
            <div className="form-hint">Text files under the path (Markdown, AsciiDoc, plain text): docs/adr/**, **/*.md.</div>
          </>
        )}
        <div className="d-flex gap-2 justify-content-end mt-2">
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={action.busy}>
            Add
          </button>
        </div>
      </form>
      {/* Outside the form: a form can't hold another. */}
      {addingToken && (
        <AddCredential
          preset="GITHUB"
          onClose={() => setAddingToken(false)}
          onSaved={(saved) => {
            setAddingToken(false);
            credentials.reload();
            setCredential(saved.name);
          }}
        />
      )}
    </>
  );
}

/**
 * A Drive folder (M43-T2): its link, and which of its files. Read through the Google connection, which must allow Drive:
 * said here before the source is added.
 */
function DriveFields({
  location,
  setLocation,
  path,
  setPath,
}: {
  location: string;
  setLocation: (value: string) => void;
  path: string;
  setPath: (value: string) => void;
}) {
  const google = useLoad(() => api.google.status(), []);
  const g = google.data;
  return (
    <>
      <div className="row g-2">
        <div className="col-sm-8">
          <label className="form-label required" htmlFor="source-folder">
            Drive folder
          </label>
          <input
            id="source-folder"
            className="form-control"
            placeholder="https://drive.google.com/drive/folders/…"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            required
          />
        </div>
        <div className="col-sm-4">
          <label className="form-label" htmlFor="source-drive-path">
            Files
          </label>
          <input id="source-drive-path" className="form-control" value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
      </div>
      <div className="form-hint">
        The folder's link (open it in Drive and copy the address). Its subfolders are read too: Google Docs, Slides, PDFs and text files.
        Files narrows it: ** for all, Specs/** for a subfolder, **/*.pdf.
      </div>
      {g && (!g.connected || !g.drive || g.status === "NEEDS_RECONNECT") && (
        <div className="alert alert-warning mt-2 mb-0" data-testid="source-drive-access">
          {!g.connected
            ? "Google isn't connected: "
            : g.status === "NEEDS_RECONNECT"
              ? "Google needs reconnecting: "
              : "Storm's Google access doesn't include Drive: "}
          <Link to="/settings#google">{g.connected ? "reconnect in Settings" : "connect it in Settings"}</Link>
          {g.connected ? " and tick Drive on Google's list." : ", and allow Drive."}
        </div>
      )}
    </>
  );
}
