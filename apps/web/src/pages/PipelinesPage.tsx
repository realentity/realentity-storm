import { IconPlus } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useLoad } from "../lib/use-load";

export function PipelinesPage() {
  const pipelines = useLoad(() => api.pipelines.list(), []);
  return (
    <>
      <PageHeader
        title="Pipelines"
        actions={
          <Link to="/pipelines/new" className="btn btn-primary" data-testid="new-pipeline">
            <IconPlus size={18} className="me-1" />
            New pipeline
          </Link>
        }
      />
      <ErrorAlert error={pipelines.error} />
      {!pipelines.data && pipelines.loading && <Loading />}
      {pipelines.data?.length === 0 && <Empty>No pipelines yet. Paste or upload a YAML definition to create one.</Empty>}
      {pipelines.data && pipelines.data.length > 0 && (
        <div className="card">
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
                {pipelines.data.map((p) => (
                  <tr key={p.pipelineId}>
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
                      <span className={`badge ${p.enabled ? "bg-green-lt" : "bg-secondary-lt"}`}>{p.enabled ? "enabled" : "disabled"}</span>
                      {p.essential && <span className="badge bg-purple-lt">essential</span>}
                    </td>
                    <td className="text-secondary">{formatDateTime(p.dateUpdated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
