import { type RunDetailView } from "@ai-me/shared";
import { IconLoader2, IconPlayerPlay } from "@tabler/icons-react";
import { outputsOf } from "../lib/data-picker";
import { StatusBadge } from "./ui";

const FINISHED = new Set(["DONE", "FAILED", "ABORTED"]);
const SHOWN = 4000;

/**
 * M37-T3: under a step's card: try the pipeline up to it (a dry run that stops after it: no side effects, nothing
 * after it), and what it gave in the last try, which the data picker of the cards after it offers.
 */
export function TryHere({
  stepId,
  run,
  stopAfter,
  onTry,
  busy,
}: Readonly<{ stepId: string; run: RunDetailView | null; stopAfter: string | null; onTry: () => void; busy: boolean }>) {
  const rows = (run?.steps ?? []).filter((s) => s.stepKey === stepId);
  const trying = run !== null && stopAfter === stepId && !FINISHED.has(run.status);
  const outputs = outputsOf(run);
  const gave = outputs[stepId];
  const failed = rows.find((s) => s.status === "FAILED");
  const skipped = rows.length > 0 && rows.every((s) => s.status === "SKIPPED");
  const text = gave === undefined ? "" : JSON.stringify(gave, null, 2);
  return (
    <div className="d-flex flex-column gap-2" data-testid="try-here-box">
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || trying}
          onClick={onTry}
          data-testid="try-here"
          title="A dry run up to this step: no side effects, nothing after it"
        >
          {trying ? <IconLoader2 size={16} className="me-1" /> : <IconPlayerPlay size={16} className="me-1" />}
          Try up to here
        </button>
        {trying && <span className="text-secondary small">Trying…</span>}
        {rows.length > 0 && !trying && (
          <>
            <StatusBadge status={failed ? "FAILED" : skipped ? "SKIPPED" : "DONE"} />
            <span className="text-secondary small">
              in the last try{rows.length > 1 ? `, ${rows.length} items` : ""}
              {skipped && `: ${rows[0].error ?? "skipped"}`}
            </span>
          </>
        )}
        {run && FINISHED.has(run.status) && rows.length === 0 && stopAfter !== null && (
          <span className="text-secondary small">The last try didn&apos;t reach it.</span>
        )}
      </div>
      {failed && (
        <div className="text-danger small" data-testid="step-output-error">
          {failed.error}
        </div>
      )}
      {gave !== undefined && (
        <details open={stopAfter === stepId}>
          <summary className="small text-secondary">What it gave</summary>
          <pre className="small mb-0 mt-1" style={{ maxHeight: 240, overflow: "auto" }} data-testid="step-output">
            {text.length > SHOWN ? `${text.slice(0, SHOWN)}\n…` : text}
          </pre>
        </details>
      )}
    </div>
  );
}
