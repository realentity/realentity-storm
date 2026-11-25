import { type GoogleAccountView } from "@realentity/storm-shared";
import { IconBrandGoogle, IconBrandGoogleDrive, IconCalendar, IconCheck, IconPlus, IconStar, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { connectGoogle } from "../lib/google";
import { useAction, useLoad } from "../lib/use-load";
import { GoogleClientCard } from "./GoogleClientCard";
import { ErrorAlert, Loading, Modal } from "./ui";

/**
 * The user's Google accounts in Settings (M50-T8: several, one the default), for the calendar (M14-T1) and topics'
 * Drive folders (M43-T2). Each: who, what was allowed, when it last worked, or what to do. A calendar step or a Drive
 * source uses the one chosen for it, else the default. The state is as last seen when Google was used; nothing checks
 * it in the background.
 */
export function GoogleAccountsCard() {
  const status = useLoad(() => api.google.status(), []);
  const action = useAction();
  const [removing, setRemoving] = useState<GoogleAccountView | null>(null);
  const [params, setParams] = useSearchParams();

  // Back from Google: say how it went, once.
  useEffect(() => {
    const outcome = params.get("google");
    if (!outcome) return;
    if (outcome === "connected") toast.success("Google connected");
    else toast.error(`Google not connected: ${outcome}`);
    params.delete("google");
    setParams(params, { replace: true });
  }, [params, setParams]);

  const g = status.data;
  const makeDefault = async (account: GoogleAccountView) => {
    const done = await action.run(async () => {
      await api.google.makeDefault(account.googleAccountId);
      return true;
    });
    if (done) {
      toast.success(`${account.email} is the default now`);
      status.reload();
    }
  };
  const remove = async (account: GoogleAccountView) => {
    const done = await action.run(async () => {
      await api.google.disconnect(account.googleAccountId);
      return true;
    });
    setRemoving(null);
    if (done) {
      toast.info(`${account.email} disconnected`);
      status.reload();
    }
  };

  return (
    <div className="d-flex flex-column gap-3">
    <GoogleClientCard redirectUri={g?.redirectUri ?? null} onChanged={status.reload} />
    <div className="card" id="google" data-testid="google-accounts">
      <div className="card-header">
        <h3 className="card-title">
          <IconBrandGoogle size={18} className="me-1" />
          Google accounts
        </h3>
        {g?.configured && (
          <button
            type="button"
            className={`btn btn-sm ms-auto ${g.accounts.length ? "" : "btn-primary"}`}
            disabled={action.busy}
            onClick={() => void action.run(() => connectGoogle("/settings/google"))}
            data-testid="google-connect"
          >
            <IconPlus size={16} className="me-1" />
            {g.accounts.length ? "Connect another" : "Connect Google"}
          </button>
        )}
      </div>
      <ErrorAlert error={status.error ?? action.error} />
      {!g && status.loading && <Loading />}
      {g && !g.configured && (
        <div className="card-body">
          <Setup />
        </div>
      )}
      {g?.configured && g.accounts.length === 0 && (
        <div className="card-body text-secondary">
          Connect a Google account so pipelines can read your calendar and propose events (calendar.find, calendar.create), and topics can
          read the Drive folders you link as their sources (read-only). Several are fine: one is the default.
        </div>
      )}
      {g && g.accounts.length > 0 && (
        <div className="list-group list-group-flush">
          {g.accounts.map((account) => (
            <div key={account.googleAccountId} className="list-group-item" data-testid={`google-account-${account.email}`}>
              <div className="d-flex align-items-center gap-2">
                <span className="fw-bold text-truncate">{account.email}</span>
                {account.isDefault && <span className="badge bg-azure-lt">default</span>}
                {account.status === "NEEDS_RECONNECT" && <span className="badge bg-red-lt">needs reconnecting</span>}
                <div className="ms-auto d-flex gap-1">
                  <button
                    type="button"
                    className={`btn btn-sm ${account.status === "CONNECTED" ? "btn-ghost-secondary" : "btn-primary"}`}
                    disabled={action.busy}
                    onClick={() => void action.run(() => connectGoogle("/settings/google", account.googleAccountId))}
                    data-testid="google-reconnect"
                  >
                    Reconnect
                  </button>
                  {!account.isDefault && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost-secondary"
                      disabled={action.busy}
                      onClick={() => void makeDefault(account)}
                      aria-label={`Make ${account.email} the default`}
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
                    aria-label={`Disconnect ${account.email}`}
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
              </div>
              {account.status === "NEEDS_RECONNECT" ? (
                <div className="text-danger small" data-testid="google-broken">
                  Since {formatDateTime(account.brokenAt)}: {account.brokenReason}. Runs that need it wait for it.
                </div>
              ) : (
                <div className="text-secondary small">
                  {account.lastWorkedAt ? `Last worked ${formatDateTime(account.lastWorkedAt)}` : "Not used yet"}
                </div>
              )}
              <div className="d-flex gap-3 mt-1 small" data-testid="google-allowed">
                <Allowed icon={<IconCalendar size={16} className="me-1" />} name="Calendar" allowed={account.calendar} />
                <Allowed icon={<IconBrandGoogleDrive size={16} className="me-1" />} name="Drive (read-only)" allowed={account.drive} />
              </div>
              {(!account.calendar || !account.drive) && (
                <div className="form-hint">Not allowed at the sign-in: Reconnect, and tick it on Google's list.</div>
              )}
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
      {removing && (
        <Modal
          title={`Disconnect ${removing.email}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => void remove(removing)}>
                Disconnect
              </button>
            </>
          }
        >
          Storm forgets its token here; to remove Storm's access at Google too, use{" "}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            your Google account's permissions
          </a>
          .{removing.usedBy.length > 0 ? ` ${removing.usedBy.map((u) => u.name).join(", ")} will use the default account instead.` : ""}
          {removing.isDefault ? " Another account becomes the default." : ""}
        </Modal>
      )}
    </div>
    </div>
  );
}

function Allowed({ icon, name, allowed }: { icon: ReactNode; name: string; allowed: boolean }) {
  return (
    <span className={allowed ? "" : "text-secondary"}>
      {icon}
      {name}:{" "}
      {allowed ? (
        <IconCheck size={16} className="text-green" aria-label="allowed" />
      ) : (
        <IconX size={16} className="text-red" aria-label="not allowed" />
      )}{" "}
      {allowed ? "allowed" : "not allowed"}
    </span>
  );
}

function Setup() {
  return (
    <div className="text-secondary small" data-testid="google-setup">
      Set up the OAuth client above first: then accounts can be connected here.
    </div>
  );
}
