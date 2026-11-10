import { type TopicBackfillView } from "@realentity/storm-shared";
import { IconHistoryToggle } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime, formatUsd } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/** Statuses that move on by themselves: the card checks again. */
const MOVING = ["ESTIMATING", "SCREENING", "PROPOSING"];

/**
 * Read a topic's history (M43-T5, docs/design.md §8.1): its past emails (by its exact directions and their threads) and
 * its sources' documents. An estimate first; nothing is read by an LLM until the user starts it; the proposals wait for
 * the user, and only the ones they pick are written.
 */
export function TopicHistory({ topicId, onApplied }: { topicId: string; onApplied: () => void }) {
  const backfill = useLoad(() => api.topics.backfill(topicId), [topicId]);
  const action = useAction();
  const b = backfill.data;
  const moving = b ? MOVING.includes(b.status) : false;
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(backfill.reload, 5_000);
    return () => window.clearInterval(timer);
  }, [moving, backfill.reload]);
  const run = async (work: () => Promise<TopicBackfillView>) => {
    const done = await action.run(work);
    if (done) backfill.reload();
    return done;
  };

  return (
    <div className="mt-3" data-testid="topic-history">
      <h4 className="mb-2">
        <IconHistoryToggle size={18} className="me-1" />
        Its history
      </h4>
      <ErrorAlert error={backfill.error ?? action.error} />
      {(!b || ["DONE", "FAILED", "CANCELLED"].includes(b.status)) && (
        <>
          {b && <LastOne backfill={b} />}
          <EstimateForm
            busy={action.busy}
            onEstimate={(months, documents) => void run(() => api.topics.estimateBackfill(topicId, { months, documents }))}
          />
        </>
      )}
      {b?.status === "ESTIMATING" && <p className="text-secondary small">Finding its past emails and documents…</p>}
      {b?.status === "ESTIMATED" && (
        <div className="d-flex align-items-center gap-2 flex-wrap" data-testid="history-estimate">
          <span>
            Found {b.emails} email{b.emails === 1 ? "" : "s"}
            {b.documents ? ` and ${b.files} document${b.files === 1 ? "" : "s"}` : ""} from the last {b.months} month
            {b.months === 1 ? "" : "s"}.
            {b.emails + b.files > 0 && (
              <> Reading them costs about {formatUsd(b.estimateUsd ?? 0)}, answered within a day (the Batch API, at half the price).</>
            )}
          </span>
          {b.emails + b.files > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={action.busy}
              onClick={() => void run(() => api.topicBackfills.start(b.topicBackfillId))}
            >
              Start
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={action.busy}
            onClick={() => void run(() => api.topicBackfills.cancel(b.topicBackfillId))}
          >
            Cancel
          </button>
        </div>
      )}
      {(b?.status === "SCREENING" || b?.status === "PROPOSING") && (
        <div className="d-flex align-items-center gap-2">
          <span className="text-secondary small">
            {b.status === "SCREENING" ? "Reading which of them say anything worth remembering" : "Reading what they say"}: the batch answers
            within a day.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={action.busy}
            onClick={() => void run(() => api.topicBackfills.cancel(b.topicBackfillId))}
          >
            Cancel
          </button>
        </div>
      )}
      {b?.status === "REVIEW" && (
        <Review
          backfill={b}
          busy={action.busy}
          onApply={async (picked) => {
            const done = await run(() => api.topicBackfills.apply(b.topicBackfillId, { picked }));
            if (done) {
              toast.success(`${done.applied} fact${done.applied === 1 ? "" : "s"} kept`);
              onApplied();
            }
          }}
          onDiscard={() => void run(() => api.topicBackfills.cancel(b.topicBackfillId))}
        />
      )}
    </div>
  );
}

function LastOne({ backfill: b }: { backfill: TopicBackfillView }) {
  const when = b.finishedAt ? formatDateTime(b.finishedAt) : "";
  const cost = b.costUsd ? `, ${formatUsd(b.costUsd)}` : "";
  const text =
    b.status === "DONE"
      ? `Read ${when}: ${b.applied} fact${b.applied === 1 ? "" : "s"} kept${cost}.`
      : b.status === "FAILED"
        ? `The last read failed ${when}: ${b.error ?? ""}`
        : `The last read was cancelled ${when}${cost}.`;
  return <p className="text-secondary small mb-2">{text}</p>;
}

function EstimateForm({ busy, onEstimate }: { busy: boolean; onEstimate: (months: number, documents: boolean) => void }) {
  const [months, setMonths] = useState(3);
  const [documents, setDocuments] = useState(true);
  return (
    <div className="d-flex align-items-center gap-2 flex-wrap" data-testid="history-form">
      <span className="text-secondary small">Read what it said before, for facts:</span>
      <select
        className="form-select form-select-sm w-auto"
        aria-label="How far back"
        value={months}
        onChange={(e) => setMonths(Number(e.target.value))}
      >
        {[1, 3, 6, 12, 24].map((m) => (
          <option key={m} value={m}>
            the last {m} month{m === 1 ? "" : "s"}
          </option>
        ))}
      </select>
      <label className="form-check form-check-inline mb-0 small">
        <input className="form-check-input" type="checkbox" checked={documents} onChange={(e) => setDocuments(e.target.checked)} />
        <span className="form-check-label">its sources' documents too</span>
      </label>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onEstimate(months, documents)}>
        Estimate
      </button>
    </div>
  );
}

function Review({
  backfill,
  busy,
  onApply,
  onDiscard,
}: {
  backfill: TopicBackfillView;
  busy: boolean;
  onApply: (picked: number[]) => Promise<void>;
  onDiscard: () => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(backfill.proposals.map((_, i) => i)));
  if (backfill.proposals.length === 0)
    return (
      <div className="d-flex align-items-center gap-2">
        <span className="text-secondary small">Nothing in its history worth remembering that it doesn't know.</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onDiscard}>
          OK
        </button>
      </div>
    );
  return (
    <div data-testid="history-review">
      <p className="text-secondary small mb-2">What its history says, oldest first: pick what goes into its memory.</p>
      <div className="list-group mb-2">
        {backfill.proposals.map((p, i) => (
          <label key={i} className="list-group-item d-flex gap-2 py-2">
            <input
              type="checkbox"
              className="form-check-input flex-shrink-0"
              checked={picked.has(i)}
              onChange={(e) =>
                setPicked((all) => {
                  const next = new Set(all);
                  if (e.target.checked) next.add(i);
                  else next.delete(i);
                  return next;
                })
              }
            />
            <span className="flex-fill overflow-hidden">
              <span className="d-block text-truncate">{p.title}</span>
              {p.quote && <span className="d-block small text-secondary text-truncate">“{p.quote}”</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="d-flex gap-2 justify-content-end">
        <button type="button" className="btn" disabled={busy} onClick={onDiscard}>
          Discard all
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || picked.size === 0} onClick={() => void onApply([...picked])}>
          Keep {picked.size}
        </button>
      </div>
    </div>
  );
}
