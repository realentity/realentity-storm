import { type BuilderChatView, type BuilderMessageView } from "@realentity/storm-shared";
import { IconDeviceFloppy, IconPencil } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/**
 * M34: an App the builder proposed with its pipelines: what each is (new) or what changes in it, its YAML, and one
 * Save all: the App and every pipeline, checked against it once more first.
 */
export function AppProposal({
  chat,
  message,
  onChanged,
  onUse,
}: {
  chat: BuilderChatView;
  message: BuilderMessageView;
  onChanged: () => void;
  /** M38-T5: in the App designer: the proposed App goes into it, to look at and save there. */
  onUse?: (source: string) => void;
}) {
  const proposal = message.appProposal!;
  const action = useAction();
  const open = proposal.status === "open";
  const save = async () => {
    const saved = await action.run(() => api.builder.saveApp(chat.chatId, message.messageId));
    if (!saved) return;
    toast.success(`Saved "${proposal.app.name}" and ${proposal.pipelines.length} pipeline(s)`);
    onChanged();
  };

  return (
    <div className={`card ${open ? "border-primary" : ""}`} data-testid="app-proposal">
      <div className="card-header">
        <div>
          <h3 className="card-title">{proposal.summary}</h3>
          <div className="text-secondary small">
            {proposal.status === "saved"
              ? "Saved"
              : proposal.status === "superseded"
                ? "Replaced by a later proposal"
                : "An App with its pipelines, saved together"}
          </div>
        </div>
        <div className="card-actions btn-list">
          {open && onUse && (
            <button type="button" className="btn btn-primary" onClick={() => onUse(proposal.app.source)} data-testid="builder-use-app">
              <IconPencil size={18} className="me-1" />
              Use in the designer
            </button>
          )}
          {open && (
            <button
              type="button"
              className={`btn ${onUse ? "" : "btn-primary"}`}
              disabled={action.busy}
              onClick={() => void save()}
              data-testid="save-app-proposal"
            >
              <IconDeviceFloppy size={18} className="me-1" />
              Save all
            </button>
          )}
          {proposal.savedAppId && (
            <Link to={`/apps/${proposal.savedAppId}`} className="btn">
              Open the App
            </Link>
          )}
        </div>
      </div>
      <div className="card-body d-flex flex-column gap-2">
        <ErrorAlert error={action.error} />
        <Part title={`App: ${proposal.app.name}`} isNew={proposal.app.isNew} changes={proposal.app.changes} source={proposal.app.source} />
        {proposal.pipelines.map((p) => (
          <Part key={p.name} title={`Pipeline: ${p.name}`} isNew={p.isNew} changes={p.changes} source={p.source} />
        ))}
      </div>
    </div>
  );
}

function Part({ title, isNew, changes, source }: { title: string; isNew: boolean; changes: string[]; source: string }) {
  return (
    <details data-testid="app-proposal-part">
      <summary>
        <strong>{title}</strong>{" "}
        <span className={`badge ${isNew ? "bg-green-lt" : "bg-blue-lt"} ms-1`}>{isNew ? "new" : `${changes.length} change(s)`}</span>
      </summary>
      {!isNew && changes.length > 0 && (
        <ul className="small mt-2 mb-2">
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <pre className="json-block mt-2 mb-0">{source}</pre>
    </details>
  );
}
