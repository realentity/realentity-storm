import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, type ReactNode } from "react";
import { ApiError, errorMessage } from "../lib/api";
import { statusLabel, statusTone } from "../lib/format";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge bg-${statusTone(status)}-lt text-nowrap`}>{statusLabel(status)}</span>;
}

/** An api error, with its field errors (paths and messages; the api never echoes values). */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const fields = error instanceof ApiError ? error.errors : [];
  return (
    <div className="alert alert-danger" role="alert">
      <div className="d-flex gap-2">
        <IconAlertTriangle size={20} className="flex-shrink-0" />
        <div>
          <div className="fw-bold">{title ?? errorMessage(error)}</div>
          {title && <div>{errorMessage(error)}</div>}
          {fields.length > 0 && (
            <ul className="mb-0 mt-1">
              {fields.map((f) => (
                <li key={`${f.path}:${f.message}`}>
                  <code>{f.path || "(root)"}</code> {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="d-flex align-items-center gap-2 text-secondary py-4">
      <span className="spinner-border spinner-border-sm" role="status" />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-secondary py-4 text-center">{children}</div>;
}

export function Json({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  if (value === null || value === undefined) return <span className="text-secondary">—</span>;
  return (
    <pre className="json-block mb-0" style={{ maxHeight }}>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function PageHeader({ title, pretitle, actions }: { title: ReactNode; pretitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header d-print-none mb-3">
      <div className="row g-2 align-items-center">
        <div className="col">
          {pretitle && <div className="page-pretitle">{pretitle}</div>}
          <h2 className="page-title">{title}</h2>
        </div>
        {actions && <div className="col-auto ms-auto d-flex gap-2 flex-wrap">{actions}</div>}
      </div>
    </div>
  );
}

/** A Tabler modal without Bootstrap's JavaScript: open while rendered. Escape and the backdrop close it. */
export function Modal({
  title,
  children,
  footer,
  onClose,
  size,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: "sm" | "lg";
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="modal modal-blur show d-block" role="dialog" aria-modal="true" onClick={onClose}>
        <div className={`modal-dialog modal-dialog-centered ${size ? `modal-${size}` : ""}`} onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{title}</h5>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-footer">{footer}</div>}
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}
