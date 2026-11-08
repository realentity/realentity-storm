import { type LiveView as LiveViewState, type RunDetailView } from "@realentity/storm-shared";
import RFB from "@novnc/novnc";
import { IconClipboard, IconHandStop, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { errorMessage } from "../lib/api";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { connectGoogle } from "../lib/google";
import { useAction, useLoad } from "../lib/use-load";

type Connection = "connecting" | "connected" | "disconnected" | "refused";

/**
 * The headed browser, live (README §6): view-only while the worker acts (the server gives the view-only password,
 * x11vnc ignores input on it); interactive once the run waits for me or I press Take over. Continue goes on from the
 * page as I left it, Abort stops the run. The clipboard box gets Cyrillic and other text past VNC's keymap.
 */
export function LiveView({ run }: { run: RunDetailView }) {
  const live = useLoad(
    () => api.runs.live(run.runId),
    [run.runId, run.status, run.takeover?.takeoverId, run.takeover?.status],
    (signal) => (signal.type === "takeover" || signal.type === "run") && signal.runId === run.runId,
  );
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [connection, setConnection] = useState<Connection>("disconnected");
  const [clipboard, setClipboard] = useState("");
  const action = useAction();
  const view = live.data;
  const password = view?.active ? view.password : null;
  // The connection stays up while no window is open, so the browser shows as soon as one opens.
  const blank = Boolean(view?.active && password && !view.window.open);

  // One connection per password: the view-only one, then the full one while I'm in control.
  useEffect(() => {
    if (!password || !screen.current) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${view?.path ?? "/vnc/"}`;
    const client = new RFB(screen.current, url, { credentials: { password }, shared: true });
    client.scaleViewport = true;
    client.viewOnly = !view?.control;
    client.focusOnClick = true;
    setConnection("connecting");
    client.addEventListener("connect", () => setConnection("connected"));
    client.addEventListener("disconnect", () => setConnection("disconnected"));
    client.addEventListener("securityfailure", () => setConnection("refused"));
    rfb.current = client;
    return () => {
      rfb.current = null;
      client.disconnect();
    };
  }, [password, view?.path, view?.control]);

  if (!run.headed) return null;
  const takeover = run.takeover;
  const act = (what: () => Promise<void>, done: string) =>
    void action
      .run(
        async () => {
          await what();
          return true;
        },
        (error) => toast.error(errorMessage(error)),
      )
      .then((ok) => ok && toast.info(done));

  const paste = () => {
    if (!rfb.current || !clipboard) return;
    rfb.current.clipboardPasteFrom(clipboard);
    toast.info("On the browser's clipboard: press Ctrl+V in the page");
  };

  return (
    <div className="card mb-3" data-testid="live-view">
      <div className="card-header">
        <h3 className="card-title">Live browser</h3>
        <span className={`badge ms-2 ${connection === "connected" ? "bg-green-lt" : "bg-secondary-lt"}`}>
          {view?.active ? (connection === "connected" ? (view.control ? "in my control" : "watching") : connection) : "not running"}
        </span>
        <div className="card-actions d-flex gap-2">
          {view?.active && !takeover && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={action.busy}
              onClick={() => act(() => api.runs.takeOver(run.runId), "Taking over at the next step point")}
              data-testid="take-over"
            >
              <IconHandStop size={16} className="me-1" />
              Take over
            </button>
          )}
          {takeover && (
            <>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={action.busy}
                onClick={() => act(() => api.runs.continue(run.runId), "Continuing")}
                data-testid="continue"
              >
                <IconPlayerPlay size={16} className="me-1" />
                Continue
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                disabled={action.busy}
                onClick={() => act(() => api.runs.abort(run.runId), "Aborted")}
                data-testid="abort"
              >
                <IconX size={16} className="me-1" />
                Abort
              </button>
            </>
          )}
        </div>
      </div>
      {takeover?.waitsFor === "google" && takeover.status === "OPEN" && (
        <div className="alert alert-warning m-3 mb-0 d-flex align-items-center gap-3 flex-wrap" data-testid="google-wait">
          <div className="flex-fill">
            <strong>It waits for Google Calendar:</strong> {takeover.reason}. Reconnect it, and the run goes on by itself. It gives up at{" "}
            {formatDateTime(takeover.expiresAt)}.
          </div>
          <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void action.run(() => connectGoogle(`/runs/${run.runId}`))}>
            Reconnect Google Calendar
          </button>
        </div>
      )}
      {takeover && takeover.waitsFor !== "google" && takeover.waitsFor !== "answer" && (
        <div className="alert alert-warning m-3 mb-0" data-testid="takeover-banner">
          <strong>{takeover.status === "OPEN" ? `It needs me: ${takeover.reason}` : "I took over"}</strong>
          {takeover.url && <span className="text-secondary"> on {hostOf(takeover.url)}</span>}. Act in the browser below, then press
          Continue (or Abort). It gives up at {formatDateTime(takeover.expiresAt)}.
        </div>
      )}
      {view && !view.available && (
        <div className="card-body text-secondary">No live view: set VNC_PASSWORD and VNC_VIEW_PASSWORD in .env.</div>
      )}
      {connection === "refused" && <div className="card-body text-danger">The live view refused the password.</div>}
      {blank && view && <NoWindow now={view.window} />}
      <div ref={screen} className="live-screen" style={{ height: password && !blank ? "70vh" : 0, background: "#1e293b" }} />
      {view?.control && (
        <div className="card-footer d-flex gap-2 align-items-start">
          <textarea
            className="form-control"
            rows={2}
            value={clipboard}
            placeholder="Text to paste into the browser (Cyrillic works here)"
            onChange={(e) => setClipboard(e.target.value)}
            aria-label="Clipboard"
          />
          <button type="button" className="btn" disabled={!clipboard} onClick={paste}>
            <IconClipboard size={18} className="me-1" />
            To the browser
          </button>
        </div>
      )}
    </div>
  );
}

/** Instead of an empty desktop: why there is no browser window now, and the run's latest screenshot. */
function NoWindow({ now }: { now: LiveViewState["window"] }) {
  return (
    <div className="card-body" data-testid="no-window">
      <div className="text-secondary mb-2">
        {now.step
          ? `Step ${now.step.stepKey} (${now.step.type}) works in a hidden browser: there is no window to watch. The browser shows here when a step opens one, or when the run needs you.`
          : "No browser window is open between steps. The browser shows here when a step opens one, or when the run needs you."}
      </div>
      {now.screenshotId && (
        <a href={api.artifactUrl(now.screenshotId)} target="_blank" rel="noreferrer">
          <img src={api.artifactUrl(now.screenshotId)} alt="The latest screenshot" className="img-fluid border rounded" style={{ maxHeight: "60vh" }} />
        </a>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
