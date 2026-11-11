import { CredentialKind, type CredentialView } from "@realentity/storm-shared";
import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { AddCredential, ConnectionHint, credentialLabel, isGitHubToken, TokenHint } from "../components/AddCredential";
import { Empty, ErrorAlert, Loading, Modal, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/**
 * Write-only credentials (docs/design.md §7): a secret goes in once (or is replaced) and is never shown again. The api
 * returns metadata only; secret inputs are cleared as soon as they are sent.
 */
export function CredentialsPage() {
  const credentials = useLoad(() => api.credentials.list(), []);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<CredentialView | null>(null);
  const [removing, setRemoving] = useState<CredentialView | null>(null);
  const remove = useAction();

  const confirmRemove = async () => {
    if (!removing) return;
    const done = await remove.run(async () => {
      await api.credentials.remove(removing.credentialId);
      return true;
    });
    if (!done) return;
    toast.info(`Deleted ${removing.name}`);
    setRemoving(null);
    credentials.reload();
  };

  return (
    <>
      <PageHeader
        title="Credentials"
        pretitle="Write-only"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-credential">
            <IconPlus size={18} className="me-1" />
            Add
          </button>
        }
      />
      <p className="text-secondary">
        Stored encrypted. Pipelines refer to them as <code>{"{{cred:name}}"}</code>: a browser sign-in, or an API key in{" "}
        <code>http.fetch</code>'s headers or query. Only the allowed hosts receive them, and no value is ever shown here or sent to the LLM.
      </p>
      <ErrorAlert error={credentials.error} />
      {!credentials.data && credentials.loading && <Loading />}
      {credentials.data?.length === 0 && <Empty>No credentials stored.</Empty>}
      {credentials.data && credentials.data.length > 0 && (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-vcenter card-table" data-testid="credentials">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Allowed hosts</th>
                  <th>Username</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {credentials.data.map((c) => (
                  <tr key={c.credentialId}>
                    <td>
                      <code>{c.name}</code>
                      <div className="small text-secondary">
                        key v{c.keyVersion} · updated {formatDateTime(c.dateUpdated)}
                      </div>
                    </td>
                    <td>{credentialLabel(c)}</td>
                    <td>{c.allowedHosts.join(", ")}</td>
                    <td>{c.username ?? <span className="text-secondary">—</span>}</td>
                    <td className="text-secondary">{formatDateTime(c.lastUsedAt)}</td>
                    <td className="text-end text-nowrap">
                      <button type="button" className="btn btn-sm" onClick={() => setReplacing(c)}>
                        <IconKey size={16} className="me-1" />
                        Replace
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost-danger ms-1" onClick={() => setRemoving(c)} title="Delete">
                        <IconTrash size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && (
        <AddCredential
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            credentials.reload();
          }}
        />
      )}
      {replacing && (
        <ReplaceSecret
          credential={replacing}
          onClose={() => setReplacing(null)}
          onSaved={() => {
            setReplacing(null);
            credentials.reload();
          }}
        />
      )}
      {removing && (
        <Modal
          title={`Delete ${removing.name}?`}
          size="sm"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={remove.busy} onClick={() => void confirmRemove()}>
                Delete
              </button>
            </>
          }
        >
          <ErrorAlert error={remove.error} />
          Pipelines that use <code>{`{{cred:${removing.name}}}`}</code> will fail at that step until it is added again.
        </Modal>
      )}
    </>
  );
}

function ReplaceSecret({ credential, onClose, onSaved }: { credential: CredentialView; onClose: () => void; onSaved: () => void }) {
  const [secret, setSecret] = useState("");
  const database = credential.kind === CredentialKind.DATABASE;
  const github = isGitHubToken(credential);
  const what = database ? "connection string" : github ? "token" : "secret";
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = github ? secret.trim() : secret;
    setSecret("");
    const saved = await action.run(() => api.credentials.replaceSecret(credential.credentialId, value));
    if (!saved) return;
    toast.success(`Replaced the ${what} of ${saved.name}`);
    onSaved();
  };
  return (
    <Modal title={`Replace the ${what} of ${credential.name}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} autoComplete="off">
        <ErrorAlert error={action.error} title="Not replaced" />
        <label className="form-label" htmlFor="replace-secret">
          New {what}
        </label>
        <div className="mb-3">
          <input
            id="replace-secret"
            type="password"
            className="form-control"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={database ? "postgresql://reader:password@host:5432/app" : github ? "github_pat_…" : undefined}
            required
          />
          {database && <ConnectionHint secret={secret} hosts={credential.allowedHosts} />}
          {github && <TokenHint secret={secret} />}
        </div>
        <div className="d-flex justify-content-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={action.busy}>
            Replace
          </button>
        </div>
      </form>
    </Modal>
  );
}
