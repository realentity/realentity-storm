import { IconCheck, IconPoint, IconRefresh } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime, statusLabel } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/** pipelines/topic-upkeep.yaml, read at build time like the examples. */
const FILES = import.meta.glob<string>("../../../../pipelines/topic-upkeep.yaml", { query: "?raw", import: "default", eager: true });
const UPKEEP = FILES["../../../../pipelines/topic-upkeep.yaml"] ?? "";

/**
 * Keep topics up to date (M42, docs/design.md §8.1): without a pipeline with topic.extract, topics only sort email and
 * nothing reaches their memory. Set up installs pipelines/topic-upkeep.yaml as an ordinary pipeline of the user's, off;
 * then what is left before it runs, and once it does, how it is doing.
 */
export function TopicUpkeepCard() {
  const upkeep = useLoad(() => api.topics.upkeep(), []);
  const action = useAction();
  const install = async () => {
    if (await action.run(() => api.pipelines.create(UPKEEP))) {
      toast.success("Topic upkeep installed, off: try it, then switch it on");
      upkeep.reload();
    }
  };
  const u = upkeep.data;
  if (!u) return <ErrorAlert error={upkeep.error} />;

  if (!u.pipeline)
    return (
      <div className="card mb-3" data-testid="topic-upkeep">
        <div className="card-body">
          <h3 className="card-title mb-1">Keep topics up to date</h3>
          <p className="text-secondary mb-2">
            Topics sort your email, but nothing reaches their memory until a pipeline reads it. Topic upkeep reads your new and sent email
            and your topics' changed documents every 15 minutes, sorts it into your topics and proposes what it states; you approve each
            fact at its gate. It sends nothing.
          </p>
          <ErrorAlert error={action.error} title="Not set up" />
          <button type="button" className="btn btn-primary" disabled={action.busy || !UPKEEP} onClick={() => void install()}>
            Set up
          </button>
        </div>
      </div>
    );

  const link = `/pipelines/${u.pipeline.pipelineId}`;
  const items: { label: string; done: boolean; link?: string; note?: string }[] = [
    {
      label: "An email account",
      done: u.email,
      link: "/credentials",
      ...(u.emailProblem ? { note: `The last mail read failed: ${u.emailProblem}` } : {}),
    },
    { label: "The LLM", done: u.llm, note: u.llm ? undefined : "Set on the server (.env)" },
    { label: "A topic with a direction: without one, no email is linked", done: u.topicsWithDirections > 0 },
    { label: "Try it: a dry run, which saves nothing", done: u.tried, link },
    { label: "Switch it on", done: u.pipeline.enabled, link },
  ];
  const done = items.every((i) => i.done);
  return (
    <div className="card mb-3" data-testid="topic-upkeep">
      <div className="card-body">
        <div className="d-flex align-items-center gap-2 mb-1">
          <h3 className="card-title mb-0 flex-fill">Keep topics up to date</h3>
          <button type="button" className="btn btn-sm btn-ghost-secondary" aria-label="Refresh" onClick={upkeep.reload}>
            <IconRefresh size={16} />
          </button>
        </div>
        <div className="text-secondary small mb-2" data-testid="topic-upkeep-status">
          <Link to={link}>{u.pipeline.name}</Link>: {u.pipeline.enabled ? "on" : "off"}
          {u.lastRun && (
            <>
              {" · "}
              <Link to={`/runs/${u.lastRun.runId}`}>
                last {u.lastRun.dryRun ? "dry run" : "run"} {u.lastRun.finishedAt ? formatDateTime(u.lastRun.finishedAt) : ""} (
                {statusLabel(u.lastRun.status)})
              </Link>
            </>
          )}
          {u.waiting > 0 && (
            <>
              {" · "}
              <Link to="/inbox" className="fw-bold">
                {u.waiting} waiting for you
              </Link>
            </>
          )}
        </div>
        {!done && (
          <ul className="list-unstyled mb-0" data-testid="topic-upkeep-checklist">
            {items.map((item) => (
              <li key={item.label} className="d-flex align-items-center gap-2 py-1">
                {item.done ? <IconCheck size={16} className="text-success" /> : <IconPoint size={16} className="text-secondary" />}
                <span className={item.done ? "text-secondary" : ""}>
                  {item.link && !item.done ? <Link to={item.link}>{item.label}</Link> : item.label}
                  {item.note && <span className="text-secondary small"> · {item.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
