import { CredentialKind, databaseConnection, type CredentialView } from "@realentity/storm-shared";
import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
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
                    <td>{c.kind.toLowerCase().replace("_", " ")}</td>
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

function AddCredential({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CredentialKind>(CredentialKind.PASSWORD);
  const [hosts, setHosts] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const action = useAction();
  const database = kind === CredentialKind.DATABASE;
  const connection = database ? databaseConnection(secret) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = secret;
    setSecret("");
    const saved = await action.run(() =>
      api.credentials.create({
        name: name.trim(),
        kind,
        // A database connects to the host its connection string names, and nowhere else.
        allowedHosts: connection
          ? [connection.host]
          : hosts
              .split(/[\s,]+/)
              .map((h) => h.trim())
              .filter(Boolean),
        username: database ? undefined : username.trim() || undefined,
        secret: value,
      }),
    );
    if (!saved) return;
    toast.success(`Stored ${saved.name}`);
    onSaved();
  };

  return (
    <Modal title="Add a credential" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} autoComplete="off" data-testid="credential-form">
        <ErrorAlert error={action.error} title="Not stored" />
        <div className="mb-3">
          <label className="form-label" htmlFor="cred-name">
            Name
          </label>
          <input
            id="cred-name"
            className="form-control"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="linkedin"
            required
          />
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="cred-kind">
            Kind
          </label>
          <select id="cred-kind" className="form-select" value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)}>
            {Object.values(CredentialKind).map((k) => (
              <option key={k} value={k}>
                {k.toLowerCase().replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        {!database && (
          <>
            <div className="mb-3">
              <label className="form-label" htmlFor="cred-hosts">
                Allowed hosts
              </label>
              <input
                id="cred-hosts"
                className="form-control"
                value={hosts}
                onChange={(e) => setHosts(e.target.value)}
                placeholder="linkedin.com, *.linkedin.com"
                required
              />
              <div className="form-hint">Exact hosts, or *.host for its subdomains. It is never sent anywhere else.</div>
            </div>
            <div className="mb-3">
              <label className="form-label" htmlFor="cred-username">
                Username (optional)
              </label>
              <input id="cred-username" className="form-control" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
          </>
        )}
        <div className="mb-3">
          <label className="form-label" htmlFor="cred-secret">
            {database ? "Connection string" : "Secret"}
          </label>
          <input
            id="cred-secret"
            type="password"
            className="form-control"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            placeholder={database ? "postgresql://reader:password@host:5432/app" : undefined}
            data-testid="credential-secret"
          />
          {database && <ConnectionHint secret={secret} />}
        </div>
        <div className="d-flex justify-content-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={action.busy || (database && !connection)}>
            Store
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * What a connection string connects to, without its password, so it can be checked before it is stored: for db.query
 * (M29), which reads only, in a read-only transaction, on this host.
 */
function ConnectionHint({ secret, hosts }: { secret: string; hosts?: string[] }) {
  const connection = databaseConnection(secret);
  if (!secret) {
    return (
      <div className="form-hint">
        For <code>db.query</code>. Use a database user that may only read; Storm reads in a read-only transaction either way.
      </div>
    );
  }
  if (!connection)
    return <div className="form-hint text-danger">Not a connection string: postgresql://user:password@host:5432/database</div>;
  const elsewhere = hosts && !hosts.includes(connection.host);
  return (
    <div className={`form-hint ${elsewhere ? "text-danger" : ""}`} data-testid="connection-hint">
      Connects to{" "}
      {connection.database ? (
        <>
          database <strong>{connection.database}</strong> on{" "}
        </>
      ) : null}
      <strong>
        {connection.host}:{connection.port}
      </strong>
      {connection.user ? (
        <>
          {" "}
          as <strong>{connection.user}</strong>
        </>
      ) : null}
      {elsewhere ? `: not ${hosts.join(", ")}. Another server is another credential.` : ", and nowhere else."}
    </div>
  );
}

function ReplaceSecret({ credential, onClose, onSaved }: { credential: CredentialView; onClose: () => void; onSaved: () => void }) {
  const [secret, setSecret] = useState("");
  const database = credential.kind === CredentialKind.DATABASE;
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = secret;
    setSecret("");
    const saved = await action.run(() => api.credentials.replaceSecret(credential.credentialId, value));
    if (!saved) return;
    toast.success(`Replaced the secret of ${saved.name}`);
    onSaved();
  };
  return (
    <Modal
      title={database ? `Replace the connection string of ${credential.name}` : `Replace the secret of ${credential.name}`}
      onClose={onClose}
    >
      <form onSubmit={(e) => void submit(e)} autoComplete="off">
        <ErrorAlert error={action.error} title="Not replaced" />
        <label className="form-label" htmlFor="replace-secret">
          {database ? "New connection string" : "New secret"}
        </label>
        <div className="mb-3">
          <input
            id="replace-secret"
            type="password"
            className="form-control"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={database ? "postgresql://reader:password@host:5432/app" : undefined}
            required
          />
          {database && <ConnectionHint secret={secret} hosts={credential.allowedHosts} />}
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
