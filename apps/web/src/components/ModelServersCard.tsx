import { type IntegrationKind, type IntegrationTestView, type IntegrationView } from "@realentity/storm-shared";
import { IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Loading, Modal } from "./ui";

/**
 * M62: Settings → AI → Model servers: Claude (its key) and servers with an OpenAI-compatible API (Ollama, LM Studio,
 * vLLM, OpenAI), each switched on and off. Keys are write-only; an address or a key is saved with the authenticator
 * code, as it decides where your email text goes.
 */
export function ModelServersCard({ onChanged }: { onChanged: () => void }) {
  const servers = useLoad(() => api.integrations.list(), []);
  const action = useAction();
  const [editing, setEditing] = useState<IntegrationView | "new" | null>(null);
  const [removing, setRemoving] = useState<IntegrationView | null>(null);
  const [tests, setTests] = useState<Record<string, IntegrationTestView | "running">>({});
  const changed = () => {
    servers.reload();
    onChanged();
  };
  const toggle = async (server: IntegrationView, enabled: boolean) => {
    if (await action.run(() => api.integrations.update(server.integrationId, { enabled }))) {
      toast.success(`${server.name} is ${enabled ? "on" : "off"}`);
      changed();
    }
  };
  const test = async (server: IntegrationView) => {
    setTests((t) => ({ ...t, [server.integrationId]: "running" }));
    try {
      const result = await api.integrations.test(server.integrationId, {});
      setTests((t) => ({ ...t, [server.integrationId]: result }));
    } catch (error) {
      setTests((t) => ({ ...t, [server.integrationId]: { ok: false, models: [], model: null, seconds: null, error: (error as Error).message } }));
    }
  };

  return (
    <div className="card" data-testid="model-servers">
      <div className="card-header">
        <h3 className="card-title">Model servers</h3>
        <div className="card-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")} data-testid="model-server-add">
            <IconPlus size={16} className="me-1" />
            Add
          </button>
        </div>
      </div>
      <ErrorAlert error={action.error ?? servers.error} />
      {!servers.data ? (
        <Loading />
      ) : servers.data.length === 0 ? (
        <div className="card-body text-secondary" data-testid="model-servers-empty">
          No model yet: add Claude (an API key from platform.claude.com) or a server of your own, e.g. Ollama. Until then the
          LLM steps and the builder have nothing to answer with.
        </div>
      ) : (
        <div className="list-group list-group-flush">
          {servers.data.map((server) => {
            const result = tests[server.integrationId];
            return (
              <div key={server.integrationId} className="list-group-item" data-testid="model-server">
                <div className="d-flex align-items-center gap-3">
                  <label className="form-check form-switch mb-0" title={server.enabled ? "On" : "Off"}>
                    <input
                      className="form-check-input"
                      type="checkbox"
                      checked={server.enabled}
                      disabled={action.busy}
                      onChange={(e) => void toggle(server, e.target.checked)}
                      aria-label={`${server.name} on`}
                    />
                  </label>
                  <div className="flex-fill">
                    <div className="fw-medium">{server.name}</div>
                    <div className="small text-secondary">
                      {server.kind === "CLAUDE" ? "Claude API" : server.baseUrl}
                      {server.secretHint ? ` · key ${server.secretHint}` : server.kind === "OPENAI_COMPATIBLE" ? " · no key" : ""}
                    </div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => void test(server)} disabled={result === "running"} data-testid="model-server-test">
                    <IconPlayerPlay size={16} className="me-1" />
                    Test
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(server)}>
                    Change
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => setRemoving(server)} aria-label={`Remove ${server.name}`}>
                    <IconTrash size={16} />
                  </button>
                </div>
                {result && (
                  <div className={`small mt-2 ${result !== "running" && !result.ok ? "text-danger" : "text-secondary"}`} data-testid="model-server-result">
                    {result === "running"
                      ? "Testing…"
                      : result.ok
                        ? `${result.models.length} model(s)${result.model ? `; ${result.model} answered in ${result.seconds} s` : ""}: ${result.models.slice(0, 8).join(", ")}${result.models.length > 8 ? ", …" : ""}`
                        : `It didn't work: ${result.error}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="card-footer small text-secondary">
        Models on your own servers cost nothing in the budget and get no effort. Setting up Ollama, and which model for what:
        docs/local-models.md.
      </div>

      {editing && (
        <ServerForm
          server={editing === "new" ? null : editing}
          claudeTaken={(servers.data ?? []).some((s) => s.kind === "CLAUDE")}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
        />
      )}
      {removing && (
        <Modal
          title={`Remove ${removing.name}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={action.busy}
                data-testid="model-server-remove"
                onClick={() =>
                  void action.run(() => api.integrations.remove(removing.integrationId)).then((done) => {
                    if (done === undefined) return;
                    toast.success(`${removing.name} removed`);
                    setRemoving(null);
                    changed();
                  })
                }
              >
                Remove
              </button>
            </>
          }
        >
          Its key is deleted. The tasks that chose one of its models go back to the default model; the embeddings, if they came
          from it, are off.
        </Modal>
      )}
    </div>
  );
}

/** Adding a server, or changing one: an address or a key is saved with the authenticator code. */
function ServerForm({ server, claudeTaken, onClose, onSaved }: { server: IntegrationView | null; claudeTaken: boolean; onClose: () => void; onSaved: () => void }) {
  const action = useAction();
  const [kind, setKind] = useState<IntegrationKind>(server?.kind ?? (claudeTaken ? "OPENAI_COMPATIBLE" : "CLAUDE"));
  const [name, setName] = useState(server?.name ?? (kind === "CLAUDE" ? "Claude" : "Ollama"));
  const [baseUrl, setBaseUrl] = useState(server?.baseUrl ?? "http://host.docker.internal:11434/v1");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const addressChanged = server ? kind === "OPENAI_COMPATIBLE" && baseUrl !== server.baseUrl : true;
  const needsCode = addressChanged || secret.trim() !== "";
  const save = async () => {
    const done = server
      ? await action.run(() =>
          api.integrations.update(server.integrationId, {
            ...(name !== server.name ? { name } : {}),
            ...(addressChanged ? { baseUrl } : {}),
            ...(secret.trim() ? { secret: secret.trim() } : {}),
            ...(needsCode ? { code } : {}),
          }),
        )
      : await action.run(() =>
          api.integrations.create(
            kind === "CLAUDE" ? { kind, name, secret: secret.trim(), code } : { kind, name, baseUrl, ...(secret.trim() ? { secret: secret.trim() } : {}), code },
          ),
        );
    if (!done) return;
    toast.success(server ? `${name} saved` : `${name} added`);
    onSaved();
  };
  return (
    <Modal
      title={server ? `Change ${server.name}` : "Add a model server"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={action.busy || (needsCode && !/^\d{6}$/.test(code))} onClick={() => void save()} data-testid="model-server-save">
            Save
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      {!server && (
        <div className="mb-3">
          <div className="form-selectgroup">
            <label className="form-selectgroup-item">
              <input type="radio" className="form-selectgroup-input" checked={kind === "CLAUDE"} disabled={claudeTaken} onChange={() => (setKind("CLAUDE"), setName("Claude"))} />
              <span className="form-selectgroup-label">Claude{claudeTaken ? " (set up)" : ""}</span>
            </label>
            <label className="form-selectgroup-item">
              <input type="radio" className="form-selectgroup-input" checked={kind === "OPENAI_COMPATIBLE"} onChange={() => (setKind("OPENAI_COMPATIBLE"), setName("Ollama"))} data-testid="model-server-kind-openai" />
              <span className="form-selectgroup-label">OpenAI-compatible server</span>
            </label>
          </div>
          {kind === "OPENAI_COMPATIBLE" && <div className="form-hint">Ollama, LM Studio, llama.cpp, vLLM, or OpenAI itself (https://api.openai.com/v1).</div>}
        </div>
      )}
      <label className="form-label">
        Name
        <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} data-testid="model-server-name" />
      </label>
      {kind === "OPENAI_COMPATIBLE" && (
        <label className="form-label w-100">
          Address, up to /v1
          <input className="form-control" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="model-server-url" />
          <span className="form-hint">Ollama on the machine Storm's containers run on: http://host.docker.internal:11434/v1</span>
        </label>
      )}
      <label className="form-label w-100">
        {kind === "CLAUDE" ? "API key" : "Key (optional; Ollama needs none)"}
        <input
          type="password"
          className="form-control"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={server?.secretHint ? `set (${server.secretHint}); type a new one to replace it` : ""}
          data-testid="model-server-key"
        />
      </label>
      {needsCode && (
        <label className="form-label">
          Code from your authenticator app
          <input
            className="form-control"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            data-testid="model-server-code"
          />
          <span className="form-hint">Asked again for an address or a key: they decide where your email text goes.</span>
        </label>
      )}
    </Modal>
  );
}
