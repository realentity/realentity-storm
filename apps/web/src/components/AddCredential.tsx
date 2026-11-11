import { CredentialKind, databaseConnection, type CredentialView } from "@realentity/storm-shared";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction } from "../lib/use-load";
import { ErrorAlert, Modal } from "./ui";

/** The one host a GitHub token goes to: GitHub's API (a topic's source, http.fetch). */
export const GITHUB_API = "api.github.com";

/**
 * What the form offers: the stored kinds, and presets that store as one of them. A GitHub token is an API key that only
 * api.github.com receives; it is not a kind of its own, so nothing else (the vault, the steps) has to know about it.
 */
type Choice = CredentialKind | "GITHUB";

/** What each choice is for, said once under the list. */
const HINTS: Record<Choice, string> = {
  GITHUB: "A fine-grained personal access token, read-only: for a topic's GitHub source, or http.fetch to api.github.com.",
  PASSWORD: "A sign-in: browser.open's login types it into the site's form. Put the account's user name under Username.",
  TOTP_SEED: "The secret behind a site's one-time codes (base32). Kept for a sign-in's second step; no step reads one yet.",
  API_KEY: "Sent as {{cred:name}} in http.fetch's or http.request's headers or query, to the allowed hosts only.",
  OAUTH_TOKEN: "An access token for an API: sent like an API key, in a header such as Authorization: Bearer {{cred:name}}.",
  STORAGE_STATE: "A browser's saved sign-in (Playwright storage state, JSON). Storm keeps these itself after a browser sign-in.",
  DATABASE: "A PostgreSQL connection string for db.query, which only reads.",
};

const LABELS: Record<Choice, string> = {
  GITHUB: "GitHub token",
  PASSWORD: "password",
  TOTP_SEED: "totp seed",
  API_KEY: "api key",
  OAUTH_TOKEN: "oauth token",
  STORAGE_STATE: "storage state",
  DATABASE: "database",
};

/** How a token GitHub issues starts: fine-grained (github_pat_), or classic and app tokens (ghp_, gho_, ghu_, ghs_, ghr_). */
const GITHUB_TOKEN = /^(github_pat_|gh[pousr]_)\w+$/;

/** A stored credential as the list shows it: an API key for api.github.com alone is a GitHub token. */
export function credentialLabel(credential: Pick<CredentialView, "kind" | "allowedHosts">): string {
  return isGitHubToken(credential) ? LABELS.GITHUB : LABELS[credential.kind];
}

export function isGitHubToken(credential: Pick<CredentialView, "kind" | "allowedHosts">): boolean {
  return credential.kind === CredentialKind.API_KEY && credential.allowedHosts.length === 1 && credential.allowedHosts[0] === GITHUB_API;
}

/**
 * Adding a credential (docs/design.md §7): its value goes in once and is never shown again; the input is cleared as soon
 * as it is sent. `preset` opens it on a choice (a topic's source asks for a GitHub token).
 */
export function AddCredential({
  preset,
  onClose,
  onSaved,
}: {
  preset?: Choice;
  onClose: () => void;
  onSaved: (saved: CredentialView) => void;
}) {
  const [name, setName] = useState(preset === "GITHUB" ? "github" : "");
  const [choice, setChoice] = useState<Choice>(preset ?? CredentialKind.PASSWORD);
  const [hosts, setHosts] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const action = useAction();
  const github = choice === "GITHUB";
  const database = choice === CredentialKind.DATABASE;
  const connection = database ? databaseConnection(secret) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = secret.trim();
    setSecret("");
    const saved = await action.run(() =>
      api.credentials.create({
        name: name.trim(),
        kind: github ? CredentialKind.API_KEY : choice,
        // A database connects to the host its connection string names, and nowhere else; a GitHub token goes to its API only.
        allowedHosts: github
          ? [GITHUB_API]
          : connection
            ? [connection.host]
            : hosts
                .split(/[\s,]+/)
                .map((h) => h.trim())
                .filter(Boolean),
        username: database || github ? undefined : username.trim() || undefined,
        secret: value,
      }),
    );
    if (!saved) return;
    toast.success(`Stored ${saved.name}`);
    onSaved(saved);
  };

  return (
    <Modal title={github ? "Add a GitHub token" : "Add a credential"} onClose={onClose}>
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
            placeholder={github ? "github-acme" : "linkedin"}
            required
          />
          <div className="form-hint">
            Referred to as <code>{`{{cred:${name.trim() || "name"}}}`}</code>.
          </div>
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="cred-kind">
            Kind
          </label>
          <select id="cred-kind" className="form-select" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
            {Object.values(CredentialKind).map((k) => (
              <option key={k} value={k}>
                {LABELS[k]}
              </option>
            ))}
            <option value="GITHUB">{LABELS.GITHUB}</option>
          </select>
          <div className="form-hint" data-testid="credential-kind-hint">
            {HINTS[choice]}
          </div>
        </div>
        {github && <GitHubSteps />}
        {github && (
          <div className="mb-3">
            <div className="form-label">Allowed hosts</div>
            <div>
              <code>{GITHUB_API}</code> <span className="text-secondary small">only: the token is never sent anywhere else.</span>
            </div>
          </div>
        )}
        {!database && !github && (
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
            {database ? "Connection string" : github ? "Token" : "Secret"}
          </label>
          <input
            id="cred-secret"
            type="password"
            className="form-control"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            placeholder={database ? "postgresql://reader:password@host:5432/app" : github ? "github_pat_…" : undefined}
            data-testid="credential-secret"
          />
          {database && <ConnectionHint secret={secret} />}
          {github && <TokenHint secret={secret} />}
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

/** Where a GitHub token comes from, and the least it needs: reading the contents of the repositories it names. */
function GitHubSteps() {
  return (
    <div className="alert alert-info" data-testid="github-steps">
      <div className="fw-bold mb-1">Make a read-only token on GitHub</div>
      <ol className="mb-1 ps-3">
        <li>
          Open{" "}
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
            Settings → Developer settings → Fine-grained tokens → Generate new token
          </a>
          .
        </li>
        <li>Resource owner: the account or organization that owns the repositories.</li>
        <li>Repository access: Only select repositories, and pick them.</li>
        <li>
          Permissions → Repository → <strong>Contents: Read-only</strong>. Nothing else (Metadata is added by itself).
        </li>
        <li>Generate it, and paste it below. GitHub shows it once.</li>
      </ol>
      <div className="small text-secondary">
        Not your GitHub password: GitHub's API doesn't take one. Repositories of another owner need a token of their own, and an
        organization may have to approve it first. When it expires, Replace its value here.
      </div>
    </div>
  );
}

/** A pasted value that isn't a GitHub token (a password, a note) is pointed out before it is stored; never repeated. */
export function TokenHint({ secret }: { secret: string }) {
  const value = secret.trim();
  if (!value || GITHUB_TOKEN.test(value)) return null;
  return (
    <div className="form-hint text-warning" data-testid="token-hint">
      This doesn't look like a GitHub token, which starts with github_pat_ (fine-grained) or ghp_ (classic).
    </div>
  );
}

/**
 * What a connection string connects to, without its password, so it can be checked before it is stored: for db.query
 * (M29), which reads only, in a read-only transaction, on this host.
 */
export function ConnectionHint({ secret, hosts }: { secret: string; hosts?: string[] }) {
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
