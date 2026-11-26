import { type AppUsesRequest, type AppUseView } from "@realentity/storm-shared";
import { IconDatabaseShare } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Loading } from "./ui";

/** A choice in the select: the App's id and the type, one string. */
const valueOf = (source: { appId: string; type: string } | null) => (source ? `${source.appId}|${source.type}` : "");

/**
 * M66: the other Apps' types an App reads (its `uses:`) and which of my Apps fills each: chosen here, kept by id. Only
 * the declared fields are read, never encrypted, credential or file fields.
 */
export function UsesCard({ load, save }: Readonly<{ load: () => Promise<AppUseView[]>; save: (body: AppUsesRequest) => Promise<AppUseView[]> }>) {
  const loaded = useLoad(load, []);
  const [shown, setShown] = useState<AppUseView[] | null>(null);
  const action = useAction();
  const views = shown ?? loaded.data;
  if (!views) return loaded.error ? <ErrorAlert error={loaded.error} /> : <Loading />;
  if (views.length === 0) return null;
  const open = views.filter((v) => !v.source || v.problems.length > 0).length;

  const choose = async (view: AppUseView, value: string) => {
    const [appId, type] = value.split("|");
    const saved = await action.run(() => save({ [view.name]: value ? { appId, type } : null }));
    if (!saved) return;
    setShown(saved);
    toast.success(value ? "Chosen" : "Cleared");
  };

  return (
    <div className="card" id="uses" data-testid="uses-card">
      <div className="card-header">
        <h3 className="card-title d-flex align-items-center gap-2">
          <IconDatabaseShare size={18} />
          Data it reads from other Apps
        </h3>
        {open > 0 && (
          <span className="badge bg-warning-lt ms-auto" data-testid="uses-missing">
            {open} to choose
          </span>
        )}
      </div>
      <div className="list-group list-group-flush">
        {views.map((view) => {
          // What fills it now stays offered even when it no longer fits, so the select shows it.
          const options = view.source && !view.fits.some((f) => valueOf(f) === valueOf(view.source)) ? [view.source, ...view.fits] : view.fits;
          return (
            <div key={view.name} className="list-group-item" data-testid={`use-${view.name}`}>
              <div className="d-flex align-items-baseline gap-2 mb-1">
                <span className="fw-bold">{view.name}</span>
                <span className="text-secondary small">
                  as {view.use.from.app} › {view.use.from.type}: {view.use.fields.join(", ")}
                </span>
              </div>
              {view.use.help && <div className="small text-secondary mb-1">{view.use.help}</div>}
              <select
                className="form-select form-select-sm"
                aria-label={`Where ${view.name} comes from`}
                value={valueOf(view.source)}
                disabled={action.busy}
                onChange={(e) => void choose(view, e.target.value)}
                data-testid={`use-source-${view.name}`}
              >
                <option value="">{options.length ? "Choose one of your Apps…" : "None of your Apps has it yet"}</option>
                {options.map((f) => (
                  <option key={valueOf(f)} value={valueOf(f)}>
                    {f.app} › {f.type}
                  </option>
                ))}
              </select>
              {view.source && view.problems.length > 0 && (
                <div className="small text-warning mt-1" data-testid={`use-problems-${view.name}`}>
                  No longer fits: {view.problems.join("; ")}
                </div>
              )}
              {options.length === 0 && (
                <div className="small mt-1">
                  <Link to="/examples">Install an App</Link> with a {view.use.from.type} type first.
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ErrorAlert error={action.error} />
    </div>
  );
}
