import { type AppPreviewView } from "@realentity/storm-shared";
import { IconLoader2 } from "@tabler/icons-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../lib/endpoints";
import { ListTable, type TableDesign } from "./ListTable";
import { ErrorAlert } from "./ui";
import { ViewValue } from "./ViewParts";

/**
 * M37-T2: a type's pages as the draft App would show them, with its entities (or made-up ones when it has none),
 * drawn again a moment after each change. On the list, a heading is dragged to move its column, clicked to sort by
 * it, and its button groups by it: each written into the page's YAML.
 */
export function PagePreview({
  source,
  appId,
  type,
  design,
}: Readonly<{ source: string; appId?: string; type: string; design: TableDesign }>) {
  const preview = usePreview(source, type, appId);
  if (!preview.view)
    return preview.error ? <ErrorAlert error={preview.error} /> : <div className="text-secondary p-3">Drawing the preview…</div>;
  const { list, view, sample } = preview.view;
  return (
    <div className="d-flex flex-column gap-3" data-testid="page-preview">
      <div className="d-flex align-items-center gap-2 small text-secondary">
        {sample ? (
          <span data-testid="preview-sample">Made-up {type} entities, from its fields: it has none yet.</span>
        ) : (
          <span>
            Your {list.total} {type} entities{list.total > list.rows.length ? `, the first ${list.rows.length}` : ""}.
          </span>
        )}
        <span>Drag a heading to move its column; click it to sort, its button to group.</span>
        {preview.drawing && <IconLoader2 size={14} className="text-secondary ms-auto" aria-label="Drawing" />}
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">{list.page.label}</h3>
          {list.page.filters.length > 0 && (
            <div className="ms-auto d-flex gap-2">
              {list.page.filters.map((f) => (
                <select key={f.field} className="form-select form-select-sm w-auto" disabled aria-label={f.label}>
                  <option>{f.label}: all</option>
                </select>
              ))}
            </div>
          )}
        </div>
        <ListTable page={list.page} rows={list.rows} groups={list.groups} rowLink={() => null} design={design} />
      </div>
      {view && (
        <div className="d-flex flex-column gap-2" data-testid="preview-view">
          <div className="small text-secondary">Its own page, for the first of them:</div>
          {view.page.sections.map((section, i) => (
            <div key={section.title ?? i} className="card">
              {section.title && (
                <div className="card-header">
                  <h3 className="card-title">{section.title}</h3>
                </div>
              )}
              <div className="card-body">
                <dl className="row mb-0">
                  {section.fields.map((column) => (
                    <Fragment key={column.field}>
                      <dt className="col-4 text-secondary fw-normal">{column.label}</dt>
                      <dd className="col-8 text-break">
                        <ViewValue row={view.row} column={column} full />
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The preview a moment after the last change; the one before stays while the next is drawn. */
function usePreview(source: string, type: string, appId?: string) {
  const [view, setView] = useState<{ key: string; view: AppPreviewView } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  const key = `${type}\u0000${source}`;
  useEffect(() => {
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      api.apps
        .preview(source, type, appId)
        .then((next) => {
          if (ticket !== latest.current) return;
          setView({ key, view: next });
          setError(null);
        })
        .catch((e: unknown) => ticket === latest.current && setError(e));
    }, 300);
    return () => clearTimeout(timer);
  }, [source, type, appId, key]);
  return { view: view?.view ?? null, drawing: view?.key !== key && !error, error };
}
