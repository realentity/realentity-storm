import { IconBraces } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { type Offer } from "../lib/data-picker";

/**
 * M36-T4: beside an input, what it may be given: the trigger's data and the earlier steps' outputs that fit, picked
 * and written as {{step.field}}. A text gets it added where it ends; anything else is replaced by it.
 */
export function DataPicker({
  offers,
  insert,
  onPick,
  label,
}: Readonly<{ offers: Offer[]; insert: boolean; onPick: (reference: string) => void; label: string }>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const shown = offers.filter((o) => `${o.reference} ${o.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(shown.map((o) => o.group))];
  return (
    <div className="position-relative d-inline-block" ref={box}>
      <button
        type="button"
        className="btn btn-sm btn-ghost-primary py-0 px-1"
        title={insert ? "Insert data from the trigger or an earlier step" : "Data from the trigger or an earlier step"}
        aria-label={`Data for ${label}`}
        onClick={() => setOpen(!open)}
        data-testid="data-picker"
      >
        <IconBraces size={16} />
        <span className="ms-1 small">{insert ? "insert data" : "data"}</span>
      </button>
      {open && (
        <div className="card position-absolute end-0 shadow" style={{ zIndex: 20, width: 360, top: "100%" }} data-testid="data-offers">
          <div className="card-body p-2">
            <input
              className="form-control form-control-sm mb-2"
              placeholder="Find…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              aria-label="Find data"
            />
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {groups.length === 0 && <div className="text-secondary small p-1">Nothing earlier gives what this takes.</div>}
              {groups.map((group) => (
                <div key={group} className="mb-1">
                  <div className="text-secondary small fw-bold px-1">{group}</div>
                  {shown
                    .filter((o) => o.group === group)
                    .map((o) => (
                      <button
                        key={o.reference}
                        type="button"
                        className="dropdown-item d-flex align-items-baseline gap-2 small py-1 px-1 text-wrap"
                        onClick={() => {
                          onPick(o.reference);
                          setOpen(false);
                        }}
                        data-testid="data-offer"
                        data-reference={o.reference}
                      >
                        <code>{o.reference}</code>
                        <span className="text-secondary">{o.kind}</span>
                        {o.description && <span className="text-secondary text-truncate">{o.description}</span>}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
