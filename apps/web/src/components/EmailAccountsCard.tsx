import { EMAIL_PRESETS, type EmailAccountRequest, type EmailAccountView } from "@realentity/storm-shared";
import { IconMail, IconPlus, IconStar, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Loading, Modal } from "./ui";

/**
 * M50-T7: the user's mailboxes in Settings: several, one the default. Email steps read and send through the one a
 * pipeline's email slot is filled with, the one an email came to, else the default. The app password is stored sealed
 * and never shown again.
 */
export function EmailAccountsCard() {
  const accounts = useLoad(() => api.emailAccounts.list(), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EmailAccountView | null>(null);
  const action = useAction();

  const makeDefault = async (account: EmailAccountView) => {
    if (await action.run(() => api.emailAccounts.update(account.emailAccountId, { isDefault: true }))) {
      toast.success(`${account.address} is the default now`);
      accounts.reload();
    }
  };
  const remove = async (account: EmailAccountView) => {
    const done = await action.run(async () => {
      await api.emailAccounts.remove(account.emailAccountId);
      return true;
    });
    setRemoving(null);
    if (done) {
      toast.success(`${account.address} removed`);
      accounts.reload();
    }
  };

  return (
    <div className="card" id="email" data-testid="email-accounts">
      <div className="card-header">
        <h3 className="card-title">
          <IconMail size={18} className="me-1" />
          Email accounts
        </h3>
        <button type="button" className="btn btn-sm ms-auto" onClick={() => setAdding(true)} data-testid="email-account-add">
          <IconPlus size={16} className="me-1" />
          Add
        </button>
      </div>
      <ErrorAlert error={accounts.error ?? action.error} />
      {!accounts.data ? (
        accounts.loading && <Loading />
      ) : accounts.data.length === 0 ? (
        <div className="card-body text-secondary">
          No email account yet: email steps read and send through one. For Gmail, turn on 2-step verification and make an{" "}
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
            app password
          </a>
          .
        </div>
      ) : (
        <div className="list-group list-group-flush">
          {accounts.data.map((account) => (
            <div key={account.emailAccountId} className="list-group-item" data-testid={`email-account-${account.address}`}>
              <div className="d-flex align-items-center gap-2">
                <span className="fw-bold text-truncate">{account.address}</span>
                {account.label && <span className="text-secondary small">{account.label}</span>}
                {account.isDefault && <span className="badge bg-azure-lt">default</span>}
                <div className="ms-auto d-flex gap-1">
                  {!account.isDefault && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost-secondary"
                      disabled={action.busy}
                      onClick={() => void makeDefault(account)}
                      aria-label={`Make ${account.address} the default`}
                      title="Make it the default"
                    >
                      <IconStar size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost-danger"
                    disabled={action.busy}
                    onClick={() => setRemoving(account)}
                    aria-label={`Remove ${account.address}`}
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
              </div>
              <div className="text-secondary small">
                {account.imapHost}:{account.imapPort} · {account.smtpHost}:{account.smtpPort}
                {account.lastUsedAt ? ` · used ${formatDateTime(account.lastUsedAt)}` : " · not used yet"}
              </div>
              {account.usedBy.length > 0 && (
                <div className="small">
                  Chosen on{" "}
                  {account.usedBy.map((use, i) => (
                    <span key={`${use.owner}:${use.id}:${use.slot}`}>
                      {i > 0 && ", "}
                      <Link to={`/${use.owner === "app" ? "apps" : "pipelines"}/${use.id}#needs`}>{use.name}</Link>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {adding && (
        <AddEmailAccount
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            toast.success(`${saved.address} added`);
            accounts.reload();
          }}
        />
      )}
      {removing && (
        <Modal
          title={`Remove ${removing.address}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => void remove(removing)}>
                Remove
              </button>
            </>
          }
        >
          Storm forgets its app password.{" "}
          {removing.usedBy.length > 0 ? `${removing.usedBy.map((u) => u.name).join(", ")} will use the default account instead.` : ""}
          {removing.isDefault ? " Another account becomes the default." : ""}
        </Modal>
      )}
    </div>
  );
}

type Preset = keyof typeof EMAIL_PRESETS | "custom";

function AddEmailAccount({ onClose, onSaved }: Readonly<{ onClose: () => void; onSaved: (saved: EmailAccountView) => void }>) {
  const [preset, setPreset] = useState<Preset>("gmail");
  const [form, setForm] = useState({ address: "", label: "", password: "", imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "465" });
  const action = useAction();
  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [field]: e.target.value });

  const submit = async () => {
    const servers =
      preset === "custom"
        ? {
            imapHost: form.imapHost.trim(),
            imapPort: Number(form.imapPort),
            smtpHost: form.smtpHost.trim(),
            smtpPort: Number(form.smtpPort),
          }
        : {
            imapHost: EMAIL_PRESETS[preset].imapHost,
            imapPort: EMAIL_PRESETS[preset].imapPort,
            smtpHost: EMAIL_PRESETS[preset].smtpHost,
            smtpPort: EMAIL_PRESETS[preset].smtpPort,
          };
    const body: EmailAccountRequest = {
      address: form.address.trim(),
      password: form.password,
      ...servers,
      ...(form.label.trim() ? { label: form.label.trim() } : {}),
    };
    const saved = await action.run(() => api.emailAccounts.create(body));
    if (saved) onSaved(saved);
  };

  return (
    <Modal
      title="Add an email account"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={action.busy || !form.address || !form.password}
            onClick={() => void submit()}
            data-testid="email-account-save"
          >
            Add
          </button>
        </>
      }
    >
      <div className="mb-3">
        <label className="form-label" htmlFor="email-preset">
          Server
        </label>
        <select id="email-preset" className="form-select" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {Object.entries(EMAIL_PRESETS).map(([key, p]) => (
            <option key={key} value={key}>
              {p.label}
            </option>
          ))}
          <option value="custom">Another server (IMAP and SMTP over TLS)</option>
        </select>
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="email-address">
          Address
        </label>
        <input id="email-address" className="form-control" type="email" autoComplete="off" value={form.address} onChange={set("address")} />
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="email-password">
          App password
        </label>
        <input
          id="email-password"
          className="form-control"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
        />
        {preset === "gmail" && (
          <div className="form-hint">
            Not your Google password: with 2-step verification on, make one at{" "}
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>
            . Stored encrypted, never shown again.
          </div>
        )}
      </div>
      {preset === "custom" && (
        <div className="row g-2 mb-3">
          <div className="col-8">
            <label className="form-label" htmlFor="email-imap">
              IMAP server
            </label>
            <input
              id="email-imap"
              className="form-control"
              placeholder="imap.example.com"
              value={form.imapHost}
              onChange={set("imapHost")}
            />
          </div>
          <div className="col-4">
            <label className="form-label" htmlFor="email-imap-port">
              Port
            </label>
            <input id="email-imap-port" className="form-control" inputMode="numeric" value={form.imapPort} onChange={set("imapPort")} />
          </div>
          <div className="col-8">
            <label className="form-label" htmlFor="email-smtp">
              SMTP server
            </label>
            <input
              id="email-smtp"
              className="form-control"
              placeholder="smtp.example.com"
              value={form.smtpHost}
              onChange={set("smtpHost")}
            />
          </div>
          <div className="col-4">
            <label className="form-label" htmlFor="email-smtp-port">
              Port
            </label>
            <input id="email-smtp-port" className="form-control" inputMode="numeric" value={form.smtpPort} onChange={set("smtpPort")} />
          </div>
        </div>
      )}
      <div className="mb-1">
        <label className="form-label" htmlFor="email-label">
          Label <span className="text-secondary">(optional)</span>
        </label>
        <input id="email-label" className="form-control" placeholder="Work" value={form.label} onChange={set("label")} />
      </div>
      <ErrorAlert error={action.error} />
    </Modal>
  );
}
