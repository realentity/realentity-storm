import { asFileRef, fieldOf, MASK, type FileRef, type FormField } from "@realentity/storm-shared";
import { IconDeviceFloppy, IconLock, IconPaperclip, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";
import { asText } from "../lib/view";

type Values = Record<string, unknown>;

/** A value as its input shows it: dates cut to what the input takes, lists a line each, yes/no as "true"/"false". */
function shown(field: FormField, value: unknown): string {
  if (value === undefined || value === null) return "";
  // M52: never shown; the api sends only that one is set (***).
  if (field.encrypted) return "";
  if (field.kind === "file" || field.kind === "image") return asFileRef(value)?.id ?? "";
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
  upload,
  appId,
  fixed = {},
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
  /** M46: uploads a file or image for a field (it is the entity's once the form is saved). */
  upload?: (field: string, file: File) => Promise<FileRef | null | undefined>;
  /** M55: the App, for a ref field's choices (its type's entities). */
  appId?: string;
  /** M55: fields set already and kept (Add on a project's page: its project). */
  fixed?: Record<string, string>;
}>) {
  // What each file field holds, by id: the entity's files, then the ones uploaded on this form.
  const [files, setFiles] = useState<Record<string, FileRef>>(() =>
    Object.fromEntries(Object.values(values).flatMap((v) => (asFileRef(v) ? [[asFileRef(v)!.id, asFileRef(v)!]] : []))),
  );
  const [uploading, setUploading] = useState<string | null>(null);
  const pick = async (field: string, file: File | undefined) => {
    if (!file || !upload) return;
    setUploading(field);
    const ref = await upload(field, file).finally(() => setUploading(null));
    if (!ref) return;
    setFiles((f) => ({ ...f, [ref.id]: ref }));
    set(field, ref.id);
  };
  const [initial] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.field, f.field in fixed ? fixed[f.field] : shown(f, values[f.field])])),
  );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const set = (field: string, value: string) => setDraft((d) => ({ ...d, [field]: value }));
  // M52: encrypted fields cleared on purpose (an empty input otherwise keeps the value that is set).
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const typed: Values = {};
    for (const f of fields) {
      const text = draft[f.field] ?? "";
      if (f.encrypted) {
        if (text !== "") typed[f.field] = text;
        else if (cleared.has(f.field)) typed[f.field] = null;
        continue;
      }
      if (changedOnly && text === (initial[f.field] ?? "") && !(f.field in fixed)) continue;
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
            {f.ref ? (
              <RefSelect field={f} appId={appId} value={value} fixed={f.field in fixed} onChange={(v) => set(f.field, v)} />
            ) : f.encrypted ? (
              <SecretInput
                field={f}
                value={value}
                isSet={values[f.field] === MASK && !cleared.has(f.field)}
                set={(text) => set(f.field, text)}
                clear={() => {
                  set(f.field, "");
                  setCleared((c) => new Set(c).add(f.field));
                }}
              />
            ) : f.kind === "file" || f.kind === "image" ? (
              <FileInput field={f} file={files[value]} busy={uploading === f.field} pick={(file) => void pick(f.field, file)} clear={() => set(f.field, "")} />
            ) : f.kind === "longtext" || f.kind === "list" ? (
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
            {f.help && <div className="form-hint">{f.help}</div>}
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
      <button type="submit" className="btn btn-primary" disabled={busy || uploading !== null}>
        <IconDeviceFloppy size={18} className="me-1" />
        {label}
      </button>
    </form>
  );
}

/** M55: a ref field: one of its type's entities, by title (its key is what is saved). */
function RefSelect({
  field,
  appId,
  value,
  fixed,
  onChange,
}: Readonly<{ field: FormField; appId: string | undefined; value: string; fixed: boolean; onChange: (value: string) => void }>) {
  const choices = useLoad(
    () => (appId && field.ref ? api.apps.page(appId, field.ref, { limit: 200 }) : Promise.resolve(null)),
    [appId, field.ref],
  );
  const options = (choices.data?.rows ?? [])
    .map((r) => ({ value: r.key, label: asText(fieldOf(r, choices.data!.page.title) ?? r.key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // One saved before its entity went: still shown, as its key.
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
  return (
    <select
      id={`field-${field.field}`}
      name={field.field}
      className="form-select"
      value={value}
      required={field.required}
      disabled={fixed}
      onChange={(e) => onChange(e.target.value)}
      data-testid={`ref-${field.field}`}
    >
      <option value="">{choices.loading ? "…" : options.length ? "Choose one…" : `No ${field.ref} yet`}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * M52: an encrypted field: never its value, only whether one is set. Replace opens the input (a password input; a
 * longtext's textarea shows what is typed), Clear removes the value when the form is saved.
 */
function SecretInput({
  field,
  value,
  isSet,
  set,
  clear,
}: Readonly<{ field: FormField; value: string; isSet: boolean; set: (text: string) => void; clear: () => void }>) {
  const [open, setOpen] = useState(!isSet);
  const id = `field-${field.field}`;
  if (!open && isSet) {
    return (
      <div className="d-flex align-items-center gap-2" data-testid={`secret-${field.field}`}>
        <IconLock size={16} className="text-secondary" />
        <span className="text-secondary">Set, encrypted</span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary ms-auto"
          onClick={() => setOpen(true)}
          data-testid={`replace-${field.field}`}
        >
          Replace
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost-danger"
          onClick={clear}
          data-testid={`clear-${field.field}`}
          aria-label={`Clear ${field.label}`}
        >
          Clear
        </button>
      </div>
    );
  }
  const common = {
    id,
    name: field.field,
    value,
    required: field.required && !isSet,
    autoComplete: "off",
    spellCheck: false,
    placeholder: isSet ? "A new value replaces the one set" : undefined,
    onChange: (e: { target: { value: string } }) => set(e.target.value),
  };
  return (
    <div data-testid={`secret-${field.field}`}>
      {field.kind === "longtext" ? (
        <textarea className="form-control font-monospace" rows={4} {...common} />
      ) : (
        <input className="form-control" type="password" {...common} />
      )}
      <div className="form-hint">
        <IconLock size={14} className="me-1" />
        Encrypted when saved; never shown again.
      </div>
    </div>
  );
}

/** M46: a file field: what it holds (an image as its thumbnail), a picker to upload another, and Remove. */
function FileInput({
  field,
  file,
  busy,
  pick,
  clear,
}: Readonly<{ field: FormField; file: FileRef | undefined; busy: boolean; pick: (file: File | undefined) => void; clear: () => void }>) {
  const id = `field-${field.field}`;
  return (
    <div data-testid={`file-${field.field}`}>
      {file && (
        <div className="d-flex align-items-center gap-2 mb-2">
          {file.mime.startsWith("image/") ? (
            <img src={api.apps.thumbUrl(file.id)} alt={file.name} className="rounded border" style={{ maxHeight: "4rem" }} />
          ) : (
            <IconPaperclip size={18} className="text-secondary" />
          )}
          <a href={api.apps.fileUrl(file.id)} target="_blank" rel="noopener noreferrer" className="text-truncate" style={{ maxWidth: "16rem" }}>
            {file.name}
          </a>
          <button type="button" className="btn btn-sm btn-ghost-secondary ms-auto" onClick={clear} aria-label={`Remove ${field.label}`}>
            <IconX size={16} />
          </button>
        </div>
      )}
      <input
        id={id}
        type="file"
        className="form-control"
        accept={field.kind === "image" ? "image/png,image/jpeg,image/webp,image/gif" : undefined}
        required={field.required && !file}
        disabled={busy}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {busy && <div className="form-hint">Uploading…</div>}
    </div>
  );
}
