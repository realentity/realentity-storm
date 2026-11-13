import { type FormField } from "@realentity/storm-shared";
import { IconDeviceFloppy } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { asText } from "../lib/view";

type Values = Record<string, unknown>;

/** A value as its input shows it: dates cut to what the input takes, lists a line each, yes/no as "true"/"false". */
function shown(field: FormField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (field.kind === "list" && Array.isArray(value)) return value.map(asText).join("\n");
  if (field.kind === "date") return asText(value).slice(0, 10);
  if (field.kind === "datetime") return asText(value).slice(0, 16);
  return asText(value);
}

/**
 * An entity's form fields (M32), an input per kind. Sent as typed: the api reads each as its kind and says what it
 * can't, per field; an empty one clears it. `changedOnly`: only the fields edited are sent, so a value a pipeline wrote
 * isn't made mine by saving next to it (M45). `written`: a field I set over what a pipeline wrote, with Reset.
 */
export function EntityForm({
  fields,
  values,
  submit,
  busy,
  label = "Save",
  testId,
  changedOnly = false,
  written = {},
  reset,
}: Readonly<{
  fields: FormField[];
  values: Values;
  submit: (values: Values) => void;
  busy: boolean;
  label?: string;
  testId?: string;
  changedOnly?: boolean;
  written?: Values;
  reset?: (field: string) => void;
}>) {
  const [initial] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.field, shown(f, values[f.field])])));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const set = (field: string, value: string) => setDraft((d) => ({ ...d, [field]: value }));
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const typed: Values = {};
    for (const f of fields) {
      const text = draft[f.field] ?? "";
      if (changedOnly && text === (initial[f.field] ?? "")) continue;
      typed[f.field] = text === "" ? null : f.kind === "yesno" ? text === "true" : text;
    }
    submit(typed);
  };

  return (
    <form onSubmit={onSubmit} data-testid={testId}>
      {fields.map((f) => {
        const id = `field-${f.field}`;
        const value = draft[f.field] ?? "";
        const common = {
          id,
          name: f.field,
          value,
          required: f.required,
          onChange: (e: { target: { value: string } }) => set(f.field, e.target.value),
        };
        return (
          <div key={f.field} className="mb-3">
            <label className={`form-label ${f.required ? "required" : ""}`} htmlFor={id}>
              {f.label}
            </label>
            {f.kind === "longtext" || f.kind === "list" ? (
              <textarea
                className="form-control"
                rows={f.kind === "list" ? 3 : 4}
                {...common}
                placeholder={f.kind === "list" ? "One per line" : undefined}
              />
            ) : f.kind === "enum" || f.kind === "yesno" ? (
              <select className="form-select" {...common}>
                <option value="">—</option>
                {(f.kind === "enum"
                  ? (f.values ?? []).map((v) => [v, v])
                  : [
                      ["true", "Yes"],
                      ["false", "No"],
                    ]
                ).map(([v, text]) => (
                  <option key={v} value={v}>
                    {text}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="form-control"
                type={
                  f.kind === "number" || f.kind === "money"
                    ? "text"
                    : f.kind === "date"
                      ? "date"
                      : f.kind === "datetime"
                        ? "datetime-local"
                        : f.kind === "url"
                          ? "url"
                          : f.kind === "email"
                            ? "email"
                            : "text"
                }
                inputMode={f.kind === "number" || f.kind === "money" ? "decimal" : undefined}
                {...common}
              />
            )}
            {f.field in written && reset && (
              <div className="form-hint d-flex flex-wrap align-items-center gap-2" data-testid={`written-${f.field}`}>
                <span>
                  Set by you. The pipeline wrote: <span className="text-body">{asText(written[f.field])}</span>
                </span>
                <button type="button" className="btn btn-link btn-sm p-0" disabled={busy} onClick={() => reset(f.field)} data-testid={`reset-${f.field}`}>
                  Reset
                </button>
              </div>
            )}
          </div>
        );
      })}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        <IconDeviceFloppy size={18} className="me-1" />
        {label}
      </button>
    </form>
  );
}
