import { JOB_STATUSES, type JobFilter, type JobPostingView, type JobStatusName } from "@ai-me/shared";
import { IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "react-toastify";
import { Empty, ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/**
 * The Jobs page (M9-T6): postings that pipelines saved (data.save), best score first, with the score's reason and
 * what I decided. Links open the posting on its site, in a new tab without a referrer.
 */
export function JobsPage() {
  const [filter, setFilter] = useState<Partial<JobFilter>>({});
  const jobs = useLoad(() => api.jobs.list(filter), [filter.status, filter.minScore, filter.q], (signal) => signal.type === "run");
  const [query, setQuery] = useState("");
  const update = useAction();

  const setStatus = async (job: JobPostingView, status: JobStatusName) => {
    const done = await update.run(() => api.jobs.setStatus(job.jobPostingId, status));
    if (!done) return;
    toast.info(`${job.title}: ${status.toLowerCase()}`);
    jobs.reload();
  };

  return (
    <>
      <PageHeader title="Jobs" pretitle="Found by pipelines" />
      <form
        className="row g-2 mb-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter((f) => ({ ...f, q: query.trim() || undefined }));
        }}
      >
        <div className="col-md-5">
          <input className="form-control" placeholder="Title or company" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        </div>
        <div className="col-auto">
          <select
            className="form-select"
            aria-label="Status"
            value={filter.status ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, status: (e.target.value || undefined) as JobStatusName | undefined }))}
          >
            <option value="">Any status</option>
            {JOB_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="col-auto">
          <select
            className="form-select"
            aria-label="Minimum score"
            value={filter.minScore ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, minScore: e.target.value ? Number(e.target.value) : undefined }))}
          >
            <option value="">Any score</option>
            {[50, 70, 80, 90].map((score) => (
              <option key={score} value={score}>
                {score}+
              </option>
            ))}
          </select>
        </div>
        <div className="col-auto">
          <button type="submit" className="btn">
            Search
          </button>
        </div>
      </form>

      <ErrorAlert error={jobs.error ?? update.error} />
      {!jobs.data && jobs.loading && <Loading />}
      {jobs.data?.length === 0 && <Empty>No postings yet. A pipeline with browser.extract and data.save fills this page.</Empty>}
      {jobs.data && jobs.data.length > 0 && (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-vcenter card-table" data-testid="jobs">
              <thead>
                <tr>
                  <th className="w-1">Score</th>
                  <th>Posting</th>
                  <th>Why</th>
                  <th>Seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((job) => (
                  <tr key={job.jobPostingId}>
                    <td>
                      {job.score === null ? (
                        <span className="text-secondary">—</span>
                      ) : (
                        <span className={`badge ${job.score >= 80 ? "bg-green-lt" : job.score >= 60 ? "bg-yellow-lt" : "bg-secondary-lt"}`}>{job.score}</span>
                      )}
                    </td>
                    <td>
                      <a href={job.url} target="_blank" rel="noopener noreferrer" className="fw-medium">
                        {job.title}
                        <IconExternalLink size={14} className="ms-1" />
                      </a>
                      <div className="small text-secondary">{[job.company, job.location, job.source].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="small text-secondary" style={{ maxWidth: 360 }}>
                      {job.scoreReason ?? "—"}
                    </td>
                    <td className="small text-secondary text-nowrap">{formatDateTime(job.firstSeenAt)}</td>
                    <td className="text-nowrap">
                      <StatusBadge status={job.status} />
                      <select
                        className="form-select form-select-sm d-inline-block w-auto ms-2"
                        aria-label={`Status of ${job.title}`}
                        value={job.status}
                        disabled={update.busy}
                        onChange={(e) => void setStatus(job, e.target.value as JobStatusName)}
                      >
                        {JOB_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status.toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </td>
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
