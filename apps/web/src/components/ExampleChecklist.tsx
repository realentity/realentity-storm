import { IconCircleCheck, IconCircleDashed, IconListCheck } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";

/**
 * M40-T3: an App installed from an example: what is left before it works (what it needs set up, then each pipeline
 * tried and switched on), each ticked as it is done; gone once all is.
 */
export function ExampleChecklist({ appId }: Readonly<{ appId: string }>) {
  const checklist = useLoad(
    () => api.examples.checklist(appId),
    [appId],
    // A run ticks "try it"; switching on is done on the pipeline's page, and seen on coming back.
    (signal) => signal.type === "run",
  );
  const view = checklist.data;
  if (!view?.items || view.done) return null;
  const left = view.items.filter((i) => !i.done).length;
  return (
    <div className="card mb-3 border-primary" data-testid="example-checklist">
      <div className="card-header">
        <h3 className="card-title">
          <IconListCheck size={18} className="me-1" />
          To make it work
        </h3>
        <span className="card-subtitle ms-2">
          {left} of {view.items.length} left
        </span>
      </div>
      <div className="list-group list-group-flush">
        {view.items.map((item) => (
          <div
            key={item.label}
            className="list-group-item d-flex align-items-center gap-2"
            data-testid="checklist-item"
            data-done={item.done}
          >
            {item.done ? <IconCircleCheck size={18} className="text-success" /> : <IconCircleDashed size={18} className="text-secondary" />}
            <span className={item.done ? "text-secondary text-decoration-line-through" : undefined}>{item.label}</span>
            {!item.done && item.note && (
              <span className={`ms-auto small ${item.link ? "text-danger" : "text-secondary"}`} data-testid="checklist-note">
                {item.note}
              </span>
            )}
            {!item.done && item.link && (
              <Link to={item.link} className={`small ${item.note ? "" : "ms-auto"}`}>
                Do it
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
