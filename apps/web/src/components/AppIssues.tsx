import { type AppIssue } from "@ai-me/shared";

/** M35: an App's problems, each with a button to its line in the YAML. */
export function Issues({ issues, onLine, testId }: { issues: AppIssue[]; onLine: (line: number) => void; testId?: string }) {
  if (issues.length === 0) return null;
  return (
    <div className="alert alert-danger" data-testid={testId}>
      <ul className="mb-0 ps-3">
        {issues.map((issue, i) => (
          <li key={i}>
            {issue.path && <code className="me-1">{issue.path}</code>}
            {issue.message}
            {issue.line !== undefined && (
              <button type="button" className="btn btn-link btn-sm p-0 ms-2 align-baseline" onClick={() => onLine(issue.line!)}>
                line {issue.line}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
