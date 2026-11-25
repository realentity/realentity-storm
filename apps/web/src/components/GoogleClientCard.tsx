import { IconBrandGoogle, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { validCode } from "../lib/code";
import { CodeField, CopyButton } from "./CodeField";
import { ErrorAlert, Loading, Modal } from "./ui";

/**
 * M63: Google's OAuth client (Settings → Google, docs/google-setup.md): a Web application client of your Google Cloud
 * project, whose redirect URI is shown here. Its secret is write-only; saving asks for the authenticator code.
 */
export function GoogleClientCard({ redirectUri, onChanged }: { redirectUri: string | null; onChanged: () => void }) {
  const client = useLoad(() => api.google.client.get(), []);
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const changed = () => {
    client.reload();
    onChanged();
  };
  const view = client.data;
  return (
    <div className="card" data-testid="google-client">
      <div className="card-header">
        <h3 className="card-title">
          <IconBrandGoogle size={18} className="me-2" />
          OAuth client
        </h3>
        <div className="card-actions d-flex gap-1">
          {view?.configured && (
            <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => setRemoving(true)} aria-label="Remove the OAuth client">
              <IconTrash size={16} />
            </button>
          )}
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(true)} data-testid="google-client-edit">
            {view?.configured ? "Change" : "Set up"}
          </button>
        </div>
      </div>
      <ErrorAlert error={action.error ?? client.error} />
      {!view ? (
        <Loading />
      ) : (
        <div className="card-body small">
          {view.configured ? (
            <div data-testid="google-client-set">
              {view.clientId} · secret {view.secretHint ?? "set"}
            </div>
          ) : (
            <div className="text-secondary" data-testid="google-client-not-set">
              Not set up: create a Web application OAuth client in Google Cloud (docs/google-setup.md) with this redirect URI, then
              save its id and secret here.
            </div>
          )}
          {redirectUri && (
            <div className="d-flex gap-1 align-items-center mt-2">
              <span className="text-secondary">Redirect URI</span>
              <code className="text-break">{redirectUri}</code>
              <CopyButton text={redirectUri} />
            </div>
          )}
        </div>
      )}
      {editing && (
        <ClientForm
          clientId={view?.clientId ?? ""}
          secretHint={view?.secretHint ?? null}
          first={!view?.configured}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            changed();
          }}
        />
      )}
      {removing && (
        <Modal
          title="Remove the OAuth client?"
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  void action.run(() => api.google.client.remove().then(() => true)).then((done) => {
                    setRemoving(false);
                    if (!done) return;
                    toast.success("The OAuth client is removed");
                    changed();
                  })
                }
              >
                Remove
              </button>
            </>
          }
        >
          Its secret is deleted. Your accounts stay, but their calendars and Drive folders can't be read until a client is saved again.
        </Modal>
      )}
    </div>
  );
}

function ClientForm({ clientId, secretHint, first, onClose, onSaved }: { clientId: string; secretHint: string | null; first: boolean; onClose: () => void; onSaved: () => void }) {
  const action = useAction();
  const [id, setId] = useState(clientId);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const ready = id.trim() !== "" && (!first || secret.trim() !== "") && validCode(code);
  const save = async () => {
    const saved = await action.run(() => api.google.client.save({ clientId: id.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}), code }));
    if (!saved) return;
    toast.success("Google's OAuth client is saved");
    onSaved();
  };
  return (
    <Modal
      title={first ? "Set up Google's OAuth client" : "Change Google's OAuth client"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={action.busy || !ready} onClick={() => void save()} data-testid="google-client-save">
            Save
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      <label className="form-label w-100">
        Client id
        <input className="form-control" value={id} onChange={(e) => setId(e.target.value)} placeholder="…apps.googleusercontent.com" data-testid="google-client-id" />
      </label>
      <label className="form-label w-100">
        Client secret
        <input
          type="password"
          className="form-control"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={secretHint ? `set (${secretHint}); type a new one to replace it` : ""}
          data-testid="google-client-secret"
        />
      </label>
      <CodeField value={code} onChange={setCode} hint="Asked again: the client decides which Google project your calendars and files are read through." testId="google-client-code" />
    </Modal>
  );
}
