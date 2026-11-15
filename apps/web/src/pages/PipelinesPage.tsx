import { IconApps, IconMessage, IconPlus, IconSearch } from "@tabler/icons-react";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ImportYaml } from "../components/ImportYaml";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { groupByApp } from "../lib/pipeline-groups";
import { useLoad } from "../lib/use-load";

export function PipelinesPage() {
  const pipelines = useLoad(() => api.pipelines.list(), []);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupByApp(pipelines.data ?? [], query), [pipelines.data, query]);
  // Headings only when there is an App to tell apart: pipelines in no App alone are just a list.
  const headings = groups.some((g) => g.app !== null);
  return (
    <>
      <PageHeader
        title="Pipelines"
        actions={
          <>
            <ImportYaml onImported={pipelines.reload} />
            <Link to="/pipelines/new" className="btn" data-testid="new-pipeline">
              <IconPlus size={18} className="me-1" />
              From YAML
            </Link>
            <Link to="/builder" className="btn btn-primary" data-testid="describe-pipeline">
              <IconMessage size={18} className="me-1" />
              Describe a pipeline
            </Link>
          </>
        }
      />
      <ErrorAlert error={pipelines.error} />
      {!pipelines.data && pipelines.loading && <Loading />}
      {pipelines.data?.length === 0 && <Empty>No pipelines yet. Describe one in chat, or paste or upload a YAML definition.</Empty>}
      {pipelines.data && pipelines.data.length > 0 && (
        <div className="card">
          <div className="card-body py-2">
            <div className="input-icon">
              <span className="input-icon-addon">
                <IconSearch size={16} />
              </span>
              <input
                type="search"
                className="form-control"
                placeholder="Find a pipeline or an App"
                aria-label="Find a pipeline or an App"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="pipelines-search"
              />
            </div>
          </div>
          {groups.length === 0 && (
            <div className="card-body text-secondary border-top">No pipeline or App has “{query.trim()}” in its name.</div>
          )}
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.app?.appId ?? "none"}>
                    {headings && (
                      <tr className="pipelines-group" data-testid="pipelines-group">
                        <th colSpan={4} className="bg-body-tertiary">
                          {group.app ? (
                            <Link to={`/apps/${group.app.appId}`} className="d-inline-flex align-items-center gap-1">
                              <IconApps size={16} />
                              {group.app.name}
                            </Link>
                          ) : (
                            <span className="text-secondary">Not in an App</span>
                          )}
                          <span className="text-secondary fw-normal ms-2">{group.pipelines.length}</span>
                        </th>
                      </tr>
                    )}
                    {group.pipelines.map((p) => (
                      <tr key={p.pipelineId} data-testid="pipeline-row">
                        <td>
                          <Link to={`/pipelines/${p.pipelineId}`} className="fw-bold">
                            {p.name}
                          </Link>
                        </td>
                        <td>
                          {p.currentVersion ? `v${p.currentVersion}` : <span className="text-secondary">not saved</span>}
                          {p.hasDraft && <span className="badge bg-azure-lt ms-2">draft</span>}
                        </td>
                        <td className="d-flex gap-1">
                          <span className={`badge ${p.enabled ? "bg-green-lt" : "bg-secondary-lt"}`}>
                            {p.enabled ? "enabled" : "disabled"}
                          </span>
                          {p.essential && <span className="badge bg-purple-lt">essential</span>}
                        </td>
                        <td className="text-secondary">{formatDateTime(p.dateUpdated)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
