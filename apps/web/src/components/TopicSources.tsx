import { type TopicSourceView } from "@realentity/storm-shared";
import { IconBrandGithub, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/endpoints";
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
          None yet. A GitHub repository (its decision records, specs) is read where it is: Storm keeps passages to quote, never a copy to
          keep up to date.
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
                if (window.confirm(`Remove ${s.location} from the topic? Its passages go; the facts read from it stay.`)) {
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
      <IconBrandGithub size={18} className="text-secondary flex-shrink-0" />
      <div className="flex-fill overflow-hidden">
        <div className="text-truncate">
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.location}
          </a>{" "}
          <code>{source.path}</code>
          {source.branch && <span className="text-secondary"> on {source.branch}</span>}
          {source.credential && <span className="badge bg-secondary-lt ms-2">{source.credential}</span>}
        </div>
        <div className="small text-secondary">
          {source.cursor
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
  const [location, setLocation] = useState("");
  const [path, setPath] = useState("docs/**");
  const [branch, setBranch] = useState("");
  const [credential, setCredential] = useState("");
  const action = useAction();
  const forGitHub = credentials.data?.filter((c) => c.allowedHosts.some((h) => h.toLowerCase() === "api.github.com")) ?? [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await action.run(() => api.topics.addSource(topicId, { kind: "GITHUB", location, path, branch, credential }))) onDone(true);
  };
  return (
    <form className="card card-body mb-2" onSubmit={(e) => void submit(e)} data-testid="source-form">
      <ErrorAlert error={action.error} title="Not added" />
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
            A private repository: a read-only token as a <Link to="/credentials">credential</Link> allowed for api.github.com.
          </div>
        </div>
      </div>
      <div className="form-hint">Text files under the path (Markdown, AsciiDoc, plain text): docs/adr/**, **/*.md.</div>
      <div className="d-flex gap-2 justify-content-end mt-2">
        <button type="button" className="btn" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={action.busy}>
          Add
        </button>
      </div>
    </form>
  );
}
