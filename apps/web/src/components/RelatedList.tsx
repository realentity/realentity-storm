import { fieldOf, type PageRelated } from "@realentity/storm-shared";
import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { asText } from "../lib/view";
import { EntityForm } from "./EntityForm";
import { ErrorAlert, Loading, Modal } from "./ui";
import { ViewValue } from "./ViewParts";

/**
 * M55: on an entity's page, the entities pointing at it (their ref field `by` holds its key): a table with its own
 * filters, each row opening its page; Add opens their form with `by` set to this one, and kept.
 */
export function RelatedList({ appId, related, of }: Readonly<{ appId: string; related: PageRelated; of: string }>) {
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const list = useLoad(
    () => api.apps.page(appId, related.type, { limit: 200, filter: JSON.stringify({ ...filter, [related.by]: of }) }),
    [appId, related.type, related.by, of, JSON.stringify(filter)],
  );
  const add = async (values: Record<string, unknown>) => {
    const added = await action.run(() => api.apps.add(appId, related.type, { ...values, [related.by]: of }));
    if (!added) return;
    toast.success(`${related.type} added`);
    setAdding(false);
    list.reload();
  };

  return (
    <div className="card" data-testid={`related-${related.type}`}>
      <div className="card-header">
        <h3 className="card-title">
          {related.label}
          {list.data && <span className="text-secondary ms-2">{list.data.total}</span>}
        </h3>
        <div className="card-actions d-flex gap-2">
          {related.filters.map((f) => (
            <select
              key={f.field}
              className="form-select form-select-sm"
              aria-label={f.label}
              value={filter[f.field] ?? ""}
              onChange={(e) => setFilter(({ [f.field]: _, ...rest }) => (e.target.value ? { ...rest, [f.field]: e.target.value } : rest))}
              data-testid={`related-filter-${f.field}`}
            >
              <option value="">{f.label}: all</option>
              {f.values.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          ))}
          {related.create && (
            <button
              type="button"
              className="btn btn-sm btn-primary text-nowrap"
              onClick={() => setAdding(true)}
              data-testid={`related-add-${related.type}`}
            >
              <IconPlus size={16} className="me-1" />
              Add
            </button>
          )}
        </div>
      </div>
      <ErrorAlert error={list.error} />
      {!list.data && list.loading && <Loading />}
      {list.data && list.data.rows.length === 0 && <div className="card-body text-secondary">None yet.</div>}
      {list.data && list.data.rows.length > 0 && (
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>{related.title}</th>
                {related.columns
                  .filter((c) => c.field !== related.title)
                  .map((c) => (
                    <th key={c.field}>{c.label}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {list.data.rows.map((row) => (
                <tr key={row.key} data-testid="related-row">
                  <td>
                    <Link to={`/a/${appId}/${encodeURIComponent(related.type)}/${encodeURIComponent(row.key)}`}>
                      {asText(fieldOf(row, related.title) ?? row.key)}
                    </Link>
                  </td>
                  {related.columns
                    .filter((c) => c.field !== related.title)
                    .map((c) => (
                      <td key={c.field}>
                        <ViewValue row={row} column={c} />
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && related.create && (
        <Modal title={`Add ${related.type}`} onClose={() => setAdding(false)}>
          <ErrorAlert error={action.error} />
          <EntityForm
            fields={related.create}
            values={{}}
            appId={appId}
            fixed={{ [related.by]: of }}
            submit={(values) => void add(values)}
            busy={action.busy}
            label="Add"
            testId="related-form"
          />
        </Modal>
      )}
    </div>
  );
}
