import { fieldOf, safeLink, type PipelineView, type ViewColumn, type ViewRow } from "@realentity/storm-shared";
import { IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage } from "../lib/api";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { asText, toNumber } from "../lib/view";
import { useAction } from "../lib/use-load";
import { Modal } from "./ui";

const DATE = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const NUMBER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** One value as its format says. Always text (React escapes it); a link only when it is http(s). */
export function ViewValue({
  row,
  column,
  full,
  inLink,
}: {
  row: ViewRow;
  column: ViewColumn;
  full?: boolean;
  /** Inside a link already (a row's title): no link of its own. */ inLink?: boolean;
}) {
  const value = fieldOf(row, column.field);
  if (value === undefined || value === null || value === "") return <span className="text-secondary">—</span>;
  switch (column.as) {
    case "number": {
      const n = toNumber(value);
      return <>{n === null ? asText(value) : NUMBER.format(n)}</>;
    }
    case "money": {
      const n = toNumber(value);
      const currency = "currency" in column && column.currency ? fieldOf(row, column.currency) : undefined;
      return <span className="text-nowrap">{n === null ? asText(value) : `${n.toFixed(2)}${currency ? ` ${asText(currency)}` : ""}`}</span>;
    }
    case "date":
    case "datetime": {
      const date = new Date(asText(value));
      if (Number.isNaN(date.getTime())) return <>{asText(value)}</>;
      return <span className="text-nowrap">{column.as === "date" ? DATE.format(date) : formatDateTime(date.toISOString())}</span>;
    }
    case "badge":
      return <span className="badge bg-secondary-lt">{asText(value)}</span>;
    case "yesno":
      return <>{value === true || value === "true" || value === 1 ? "yes" : "no"}</>;
    case "link": {
      const href = safeLink(value);
      return href ? <ShortLink href={href} /> : <>{asText(value)}</>;
    }
    default: {
      if (full) return <span style={{ whiteSpace: "pre-wrap" }}>{asText(value)}</span>;
      // A text that is a web address (a feed's url kept as text) reads as one: short, not a wide column.
      const href = !inLink && typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim()) ? safeLink(value.trim()) : null;
      if (href) return <ShortLink href={href} />;
      return (
        <span className="text-truncate d-inline-block align-bottom" style={{ maxWidth: "24rem" }} title={asText(value)}>
          {asText(value)}
        </span>
      );
    }
  }
}

/** A link as its host and path, cut at the end to fit a column; the whole address on hover. */
function ShortLink({ href }: Readonly<{ href: string }>) {
  const url = new URL(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-truncate d-inline-block align-bottom"
      style={{ maxWidth: "18rem" }}
      title={href}
    >
      {url.hostname}
      {url.pathname === "/" ? "" : url.pathname}
    </a>
  );
}

/** The view's link of a row, as an icon that opens it. */
export function RowLink({ view, row }: { view: PipelineView; row: ViewRow }) {
  const href = view.link ? safeLink(fieldOf(row, view.link)) : null;
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="btn btn-ghost-secondary btn-icon btn-sm" title={href}>
      <IconExternalLink size={16} />
    </a>
  );
}

/** My marks on a row, as toggles. */
export function RowMarks({
  pipelineId,
  view,
  row,
  onChanged,
}: {
  pipelineId: string;
  view: PipelineView;
  row: ViewRow;
  onChanged: () => void;
}) {
  const action = useAction();
  const toggle = async (markId: string) => {
    const done = await action.run(
      () => api.views.mark(pipelineId, row.key, markId, !(markId in row.marks)),
      (error) => toast.error(errorMessage(error)),
    );
    if (done) onChanged();
  };
  return (
    <>
      {view.marks.map((mark) => (
        <button
          key={mark.id}
          type="button"
          className={`btn btn-sm ${mark.id in row.marks ? "btn-success" : "btn-outline-secondary"}`}
          disabled={action.busy}
          data-testid={`mark-${mark.id}`}
          onClick={() => void toggle(mark.id)}
        >
          {mark.label}
        </button>
      ))}
    </>
  );
}

/** The view's buttons: the page's (no row) or a row's. Each starts a run, after a question when it has one. */
export function ViewActions({ pipelineId, view, row, size }: { pipelineId: string; view: PipelineView; row?: ViewRow; size?: "sm" }) {
  const navigate = useNavigate();
  const action = useAction();
  const [asking, setAsking] = useState<number | null>(null);
  const buttons = view.actions.map((a, index) => ({ ...a, index })).filter((a) => a.row === (row !== undefined));
  if (buttons.length === 0) return null;

  const start = async (index: number) => {
    setAsking(null);
    const run = await action.run(
      () => api.views.act(pipelineId, index, row?.key),
      (error) => toast.error(errorMessage(error)),
    );
    if (!run) return;
    toast.info(`Started ${run.pipelineName}`);
    void navigate(`/runs/${run.runId}`);
  };
  const question = asking === null ? undefined : view.actions[asking];

  return (
    <>
      {buttons.map((button) => (
        <button
          key={button.index}
          type="button"
          className={`btn ${size === "sm" ? "btn-sm" : ""} ${row ? "btn-outline-primary" : "btn-primary"}`}
          disabled={action.busy}
          onClick={() => (button.confirm ? setAsking(button.index) : void start(button.index))}
        >
          {button.label}
        </button>
      ))}
      {question && asking !== null && (
        <Modal
          title={question.label}
          size="sm"
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void start(asking)}>
                Start
              </button>
            </>
          }
        >
          {question.confirm}
        </Modal>
      )}
    </>
  );
}
