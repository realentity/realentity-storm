import { EMAIL_LABELS, emailFields, threadLength } from "../lib/email-payload";
import { Json } from "./ui";

const label = (field: string) => EMAIL_LABELS[field] ?? field;

/** A header or the message as text: strings as they are, anything else (a wrong type from a pipeline) as JSON. */
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : JSON.stringify(value));

function Edited({ on }: Readonly<{ on: boolean }>) {
  return on ? <span className="badge bg-blue-lt ms-2">edited</span> : null;
}

/**
 * An email at its gate, read as an email (docs/design.md §3): To and Subject, the message as it will be sent, and the
 * threading folded away. The same payload as the generic view: only how it is shown differs.
 */
export function EmailView({ payload, changed }: Readonly<{ payload: Record<string, unknown>; changed: readonly string[] }>) {
  const fields = emailFields(payload);
  const earlier = threadLength(payload);
  return (
    <div data-testid="payload" className="email-view">
      <dl className="email-headers mb-0">
        {fields.headers.map((field) => (
          <div key={field} className="email-header" data-testid={`email-${field}`}>
            <dt>{label(field)}</dt>
            <dd className={field === "subject" ? "fw-bold" : undefined}>
              {text(payload[field])}
              <Edited on={changed.includes(field)} />
            </dd>
          </div>
        ))}
      </dl>
      {fields.body && (
        <div className="email-body" data-testid="email-body">
          {changed.includes("body") && (
            <div className="mb-2">
              <span className="badge bg-blue-lt">edited</span>
            </div>
          )}
          {text(payload.body)}
        </div>
      )}
      {fields.other.map((field) => (
        <div key={field} className="mt-3">
          <div className="fw-bold small mb-1">
            {field}
            <Edited on={changed.includes(field)} />
          </div>
          {typeof payload[field] === "string" ? <div className="payload-text">{payload[field]}</div> : <Json value={payload[field]} />}
        </div>
      ))}
      {fields.thread.length > 0 && (
        <details className="mt-3 small text-secondary" data-testid="email-thread">
          <summary>
            A reply in the same thread{earlier > 0 && <> ({earlier === 1 ? "1 earlier message" : `${earlier} earlier messages`})</>}
          </summary>
          <dl className="mt-2 mb-0">
            {fields.thread.map((field) => (
              <div key={field} className="mb-1">
                <dt className="fw-normal">
                  {label(field)}
                  <Edited on={changed.includes(field)} />
                </dt>
                <dd className="mb-0 font-monospace text-break">
                  {Array.isArray(payload[field]) ? (payload[field] as unknown[]).map(text).join(" ") : text(payload[field])}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

/** The email's fields to edit: To and Subject on a line each, the message in a large box, the threading as JSON, folded away. */
export function EmailEditor({
  original,
  texts,
  onChange,
  changed,
  invalid,
}: Readonly<{
  original: Record<string, unknown>;
  texts: Record<string, string>;
  onChange: (field: string, text: string) => void;
  changed: readonly string[];
  invalid: readonly string[];
}>) {
  const fields = emailFields(original);
  const heading = (field: string, json = false) => (
    <label className="form-label d-flex justify-content-between" htmlFor={`field-${field}`}>
      <span>
        {label(field)} {json && <span className="text-secondary small">(JSON)</span>}
      </span>
      {changed.includes(field) && <span className="badge bg-blue-lt">edited</span>}
    </label>
  );
  const box = (field: string, mono: boolean) => {
    const value = texts[field] ?? "";
    return (
      <div key={field}>
        {heading(field, typeof original[field] !== "string")}
        <textarea
          id={`field-${field}`}
          className={`form-control ${mono ? "font-monospace" : ""} ${invalid.includes(field) ? "is-invalid" : ""}`}
          rows={Math.min(field === "body" ? 24 : 14, Math.max(field === "body" ? 8 : 2, value.split("\n").length + 1))}
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          data-testid={`field-${field}`}
        />
        {invalid.includes(field) && <div className="invalid-feedback">Not valid JSON</div>}
      </div>
    );
  };
  return (
    <div className="d-flex flex-column gap-3">
      {fields.headers.map((field) => (
        <div key={field}>
          {heading(field)}
          <input
            id={`field-${field}`}
            className="form-control"
            value={texts[field] ?? ""}
            onChange={(e) => onChange(field, e.target.value)}
            data-testid={`field-${field}`}
          />
        </div>
      ))}
      {fields.body && box(fields.body, false)}
      {fields.other.map((field) => box(field, typeof original[field] !== "string"))}
      {fields.thread.length > 0 && (
        <details open={fields.thread.some((field) => invalid.includes(field)) || undefined}>
          <summary className="small text-secondary mb-2">The thread it replies in</summary>
          <div className="d-flex flex-column gap-3">{fields.thread.map((field) => box(field, true))}</div>
        </details>
      )}
    </div>
  );
}
