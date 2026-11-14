import { CredentialKind, emptySlots, type BindingsRequest, type BindingView, type CredentialView, type Need } from "@realentity/storm-shared";
import { IconKey, IconPencil } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { useAction, useLoad } from "../lib/use-load";
import { AddCredential } from "./AddCredential";
import { ErrorAlert, Loading } from "./ui";

const ADD = "__add__";

/** The credential kind a slot asks for, to start the form on. */
function kindOf(need: Need): CredentialKind | undefined {
  if (need.kind !== "credential" || !need.type) return need.kind === "credential" && need.for ? CredentialKind.API_KEY : undefined;
  return need.type.toUpperCase() as CredentialKind;
}

/**
 * M50: what a pipeline or an App install needs (its slots) and what fills each: one of the user's credentials that fits
 * (or a new one, added here with its kind and host filled in), or a text setting. A slot its App fills is shown, set on
 * the App's page. Never by a credential's name: the choice is stored by id.
 */
export function NeedsCard({
  load,
  save,
  app,
  title = "What it needs",
  onChanged,
}: Readonly<{
  load: () => Promise<BindingView[]>;
  save: (body: BindingsRequest) => Promise<BindingView[]>;
  /** On a pipeline's page: its App's page, where the App's slots are filled. */
  app?: { appId: string; name: string };
  title?: string;
  onChanged?: (views: BindingView[]) => void;
}>) {
  const loaded = useLoad(load, []);
  const [shown, setShown] = useState<BindingView[] | null>(null);
  const [adding, setAdding] = useState<BindingView | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const action = useAction();
  const views = shown ?? loaded.data;
  if (!views) return loaded.error ? <ErrorAlert error={loaded.error} /> : <Loading />;
  if (views.length === 0) return null;
  const empty = emptySlots(views);

  const put = async (body: BindingsRequest, done: string) => {
    const saved = await action.run(() => save(body));
    if (!saved) return;
    setShown(saved);
    onChanged?.(saved);
    toast.success(done);
  };
  const choose = (view: BindingView, credentialId: string) => {
    if (credentialId === ADD) return setAdding(view);
    void put({ [view.slot]: { credentialId: credentialId || null } }, credentialId ? "Chosen" : "Cleared");
  };

  return (
    <div className="card" id="needs" data-testid="needs-card">
      <div className="card-header">
        <h3 className="card-title d-flex align-items-center gap-2">
          <IconKey size={18} />
          {title}
        </h3>
        {empty.length > 0 && (
          <span className="badge bg-warning-lt ms-auto" data-testid="needs-missing">
            {empty.length} to fill in
          </span>
        )}
      </div>
      <div className="list-group list-group-flush">
        {views.map((view) => {
          const label = view.need.label ?? view.slot;
          const readOnly = view.owner === "app" && app !== undefined;
          return (
            <div key={`${view.owner}:${view.slot}`} className="list-group-item" data-testid={`need-${view.slot}`}>
              <div className="d-flex align-items-baseline gap-2 mb-1">
                <span className="fw-bold">{label}</span>
                {view.need.kind === "credential" && view.need.for && <span className="text-secondary small">for {view.need.for}</span>}
                {readOnly && <span className="badge bg-azure-lt">the App's</span>}
              </div>
              {readOnly ? (
                <div className="small">
                  {view.credential?.name ?? view.text ?? <span className="text-warning">not set</span>}
                  {" · "}
                  <Link to={`/apps/${app.appId}#needs`}>set on {app.name}</Link>
                </div>
              ) : view.need.kind === "credential" ? (
                <select
                  className="form-select form-select-sm"
                  aria-label={label}
                  value={view.credential?.credentialId ?? ""}
                  disabled={action.busy}
                  onChange={(e) => choose(view, e.target.value)}
                  data-testid={`need-credential-${view.slot}`}
                >
                  <option value="">{view.fits.length ? "Choose one…" : "None of yours fits yet"}</option>
                  {view.fits.map((c) => (
                    <option key={c.credentialId} value={c.credentialId}>
                      {c.name}
                    </option>
                  ))}
                  <option value={ADD}>Add a new one…</option>
                </select>
              ) : (
                <form
                  className="d-flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = (texts[view.slot] ?? view.text ?? "").trim();
                    void put({ [view.slot]: { text: text || null } }, "Saved");
                  }}
                >
                  <input
                    className="form-control form-control-sm"
                    aria-label={label}
                    placeholder={view.need.kind === "text" ? view.need.example : undefined}
                    value={texts[view.slot] ?? view.text ?? ""}
                    onChange={(e) => setTexts({ ...texts, [view.slot]: e.target.value })}
                    data-testid={`need-text-${view.slot}`}
                  />
                  <button type="submit" className="btn btn-sm" disabled={action.busy} aria-label={`Save ${label}`}>
                    <IconPencil size={16} />
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>
      <ErrorAlert error={action.error} />
      {adding && adding.need.kind === "credential" && (
        <AddCredential
          preset={kindOf(adding.need)}
          hosts={adding.need.for ? [adding.need.for] : []}
          name={adding.slot}
          onClose={() => setAdding(null)}
          onSaved={(saved: CredentialView) => {
            const slot = adding;
            setAdding(null);
            void put({ [slot.slot]: { credentialId: saved.credentialId } }, `${saved.name} added and chosen`);
          }}
        />
      )}
    </div>
  );
}
