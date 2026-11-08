import { type GoogleStatusView } from "@realentity/storm-shared";
import { IconBrandGoogle, IconCalendar } from "@tabler/icons-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { connectGoogle } from "../lib/google";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Loading } from "./ui";

/**
 * Google Calendar (M14-T1) in Settings: connected as whom and when it last worked, or what to do. The state is as
 * last seen when the calendar was used; nothing checks it in the background.
 */
export function GoogleCalendarCard() {
  const status = useLoad(() => api.google.status(), []);
  const action = useAction();
  const [params, setParams] = useSearchParams();

  // Back from Google: say how it went, once.
  useEffect(() => {
    const outcome = params.get("google");
    if (!outcome) return;
    if (outcome === "connected") toast.success("Google Calendar connected");
    else toast.error(`Google Calendar not connected: ${outcome}`);
    params.delete("google");
    setParams(params, { replace: true });
  }, [params, setParams]);

  const g = status.data;
  return (
    <div className="card" id="google" data-testid="google-calendar">
      <div className="card-header">
        <h3 className="card-title">
          <IconCalendar size={18} className="me-1" />
          Google Calendar
        </h3>
        {g && <Badge g={g} />}
      </div>
      <div className="card-body">
        <ErrorAlert error={status.error ?? action.error} />
        {!g && status.loading && <Loading />}
        {g && !g.configured && <Setup g={g} />}
        {g?.configured && !g.connected && (
          <p className="text-secondary">Connect your Google account so pipelines can read your calendar and propose events (calendar.find, calendar.create).</p>
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
              {g.connected ? "Reconnect" : "Connect Google Calendar"}
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
      Not set up: create an OAuth client in Google Cloud (docs/google-calendar-setup.md) with this redirect URI, then put its id and
      secret in <code>.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>:
      <div className="mt-1">
        <code>{g.redirectUri}</code>
      </div>
    </div>
  );
}
