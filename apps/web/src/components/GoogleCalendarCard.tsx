import { type GoogleStatusView } from "@realentity/storm-shared";
import { IconBrandGoogle, IconBrandGoogleDrive, IconCalendar, IconCheck, IconX } from "@tabler/icons-react";
import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { connectGoogle } from "../lib/google";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Loading } from "./ui";

/**
 * The Google connection in Settings: the calendar (M14-T1) and topics' Drive folders (M43-T2), one sign-in for both.
 * Connected as whom, what was allowed, and when it last worked, or what to do. The state is as last seen when Google
 * was used; nothing checks it in the background.
 */
export function GoogleCalendarCard() {
  const status = useLoad(() => api.google.status(), []);
  const action = useAction();
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
  return (
    <div className="card" id="google" data-testid="google-calendar">
      <div className="card-header">
        <h3 className="card-title">
          <IconBrandGoogle size={18} className="me-1" />
          Google Calendar and Drive
        </h3>
        {g && <Badge g={g} />}
      </div>
      <div className="card-body">
        <ErrorAlert error={status.error ?? action.error} />
        {!g && status.loading && <Loading />}
        {g && !g.configured && <Setup g={g} />}
        {g?.configured && !g.connected && (
          <p className="text-secondary">
            Connect your Google account so pipelines can read your calendar and propose events (calendar.find, calendar.create), and topics
            can read the Drive folders you link as their sources (read-only).
          </p>
        )}
        {g?.connected && (
          <div className="mb-3">
            <div>
              Connected as <strong>{g.email}</strong>
            </div>
            {g.status === "NEEDS_RECONNECT" ? (
              <div className="text-danger small" data-testid="google-broken">
                Needs reconnecting since {formatDateTime(g.brokenAt)}: {g.brokenReason}. Runs that need the calendar wait for it.
              </div>
            ) : (
              <div className="text-secondary small">{g.lastWorkedAt ? `Last worked ${formatDateTime(g.lastWorkedAt)}` : "Not used yet"}</div>
            )}
            <div className="d-flex gap-3 mt-2 small" data-testid="google-allowed">
              <Allowed icon={<IconCalendar size={16} className="me-1" />} name="Calendar" allowed={g.calendar} />
              <Allowed icon={<IconBrandGoogleDrive size={16} className="me-1" />} name="Drive (read-only)" allowed={g.drive} />
            </div>
            {(!g.calendar || !g.drive) && (
              <div className="form-hint">Not allowed at the sign-in: Reconnect, and tick it on Google's list.</div>
            )}
          </div>
        )}
        {g?.configured && (
          <div className="d-flex gap-2 flex-wrap">
            <button
              type="button"
              className={`btn ${g.status === "CONNECTED" ? "" : "btn-primary"}`}
              disabled={action.busy}
              onClick={() => void action.run(() => connectGoogle())}
              data-testid="google-connect"
            >
              <IconBrandGoogle size={18} className="me-1" />
              {g.connected ? "Reconnect" : "Connect Google"}
            </button>
            {g.connected && (
              <button
                type="button"
                className="btn btn-outline-danger"
                disabled={action.busy}
                onClick={() =>
                  void action
                    .run(async () => {
                      await api.google.disconnect();
                      return true;
                    })
                    .then((done) => {
                      if (!done) return;
                      toast.info("Disconnected");
                      status.reload();
                    })
                }
              >
                Disconnect
              </button>
            )}
          </div>
        )}
        {g?.connected && (
          <div className="form-hint mt-2">
            Disconnect forgets the token here; to remove Storm's access at Google too, use{" "}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              your Google account's permissions
            </a>
            .
          </div>
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

function Badge({ g }: { g: GoogleStatusView }) {
  if (!g.connected) return <span className="badge bg-secondary-lt ms-2">not connected</span>;
  return g.status === "CONNECTED" ? (
    <span className="badge bg-green-lt ms-2">connected</span>
  ) : (
    <span className="badge bg-red-lt ms-2">needs reconnecting</span>
  );
}

function Setup({ g }: { g: GoogleStatusView }) {
  return (
    <div className="text-secondary small" data-testid="google-setup">
      Not set up: create an OAuth client in Google Cloud (docs/google-setup.md) with this redirect URI, then put its id and
      secret in <code>.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>:
      <div className="mt-1">
        <code>{g.redirectUri}</code>
      </div>
    </div>
  );
}
