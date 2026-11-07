import {
  addField,
  addType,
  APP_NAME,
  ENTITY_FIELD,
  FIELD_KINDS,
  removeField,
  removeType,
  renameField,
  renameType,
  setField,
  setAppProperty,
  setTypeProperty,
  TYPE_NAME,
  VIEW_ICONS,
  type AppIssue,
} from "@ai-me/shared";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { text, type LooseApp, type LooseType } from "../lib/loose-app";
import { Issues } from "./AppIssues";

/** A change to the App's YAML, made by one of the designer's edits. */
export type DesignerEdit = (source: string) => string;

const KEY_KINDS = new Set(["text", "url", "email", "number"]);

/**
 * M35-T2: an App's types as tables, a row per field: every change an edit of the YAML (a rename made where the App
 * uses it). What its pipelines would lose is in the check, before Save.
 */
export function TypesDesigner({
  app,
  issues,
  onLine,
  onEdit,
  editable,
  entities,
}: Readonly<{
  app: LooseApp;
  issues: AppIssue[];
  onLine: (line: number) => void;
  onEdit: (edit: DesignerEdit, note?: string) => void;
  /** False while the YAML has errors: they are fixed on the YAML tab first. */
  editable: boolean;
  /** Entities already kept, by type: a rename leaves them as they are. */
  entities: Record<string, number>;
}>) {
  const [newType, setNewType] = useState("");
  const renamedNote = (type: string) =>
    entities[type]
      ? `The ${entities[type]} ${type} entities already kept keep the old name: pipelines write the new one from now on.`
      : undefined;
  return (
    <div className="card-body d-flex flex-column gap-4" data-testid="types-tab">
      {!editable && <div className="alert alert-warning mb-0">The YAML has errors: fix them on the YAML tab to change the types here.</div>}
      {app.types.length === 0 && <div className="text-secondary">No types yet.</div>}
      {app.types.map(([name, type]) => (
        <TypeTable
          key={name}
          name={name}
          type={type}
          issues={issues.filter((i) => i.path === `types.${name}` || i.path.startsWith(`types.${name}.`))}
          onLine={onLine}
          onEdit={onEdit}
          editable={editable}
          renamedNote={renamedNote(name)}
        />
      ))}
      {editable && (
        <form
          className="d-flex gap-2 align-items-center"
          onSubmit={(e) => {
            e.preventDefault();
            onEdit((s) => addType(s, newType));
            setNewType("");
          }}
        >
          <input
            className="form-control w-auto"
            placeholder="NewType"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            aria-label="New type's name"
            data-testid="new-type-name"
          />
          <button type="submit" className="btn" disabled={!TYPE_NAME.test(newType)} data-testid="add-type-row">
            <IconPlus size={16} className="me-1" />
            Add a type
          </button>
          <span className="text-secondary small">A capital letter, then letters and digits</span>
        </form>
      )}
    </div>
  );
}

function TypeTable({
  name,
  type,
  issues,
  onLine,
  onEdit,
  editable,
  renamedNote,
}: Readonly<{
  name: string;
  type: LooseType;
  issues: AppIssue[];
  onLine: (line: number) => void;
  onEdit: (edit: DesignerEdit, note?: string) => void;
  editable: boolean;
  renamedNote?: string;
}>) {
  const fieldNames = type.fields.map(([f]) => f);
  const textFields = type.fields.filter(([, def]) => def.type === "text").map(([f]) => f);
  const [newField, setNewField] = useState("");
  const [newKind, setNewKind] = useState<string>("text");
  const fieldIssues = (field: string) =>
    issues.filter((i) => i.path === `types.${name}.fields.${field}` || i.path.startsWith(`types.${name}.fields.${field}.`));
  const typeIssues = issues.filter((i) => !i.path.startsWith(`types.${name}.fields.`));
  return (
    <div data-testid="designer-type">
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <CommitInput
          value={name}
          className="form-control fw-bold w-auto"
          valid={(v) => TYPE_NAME.test(v)}
          onCommit={(to) => onEdit((s) => renameType(s, name, to), renamedNote)}
          disabled={!editable}
          ariaLabel={`${name}'s name`}
          testId="type-name"
        />
        <label className="form-check form-switch mb-0 ms-2" title="Mine: added and changed by me on its pages; pipelines only read it">
          <input
            type="checkbox"
            className="form-check-input"
            checked={type.mine === true}
            disabled={!editable}
            onChange={(e) => onEdit((s) => setTypeProperty(s, name, "mine", e.target.checked))}
            data-testid="type-mine"
          />
          <span className="form-check-label">Mine</span>
        </label>
        <span className="text-secondary small ms-3">Key</span>
        <select
          className="form-select form-select-sm w-auto"
          value={text(type.key)}
          disabled={!editable}
          onChange={(e) => onEdit((s) => setTypeProperty(s, name, "key", e.target.value))}
          aria-label={`${name}'s key`}
          data-testid="type-key"
        >
          {!fieldNames.includes(text(type.key)) && <option value={text(type.key)}>{text(type.key) || "…"}</option>}
          {type.fields
            .filter(([, def]) => KEY_KINDS.has(text(def.type)))
            .map(([f]) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
        </select>
        <span className="text-secondary small">Title</span>
        <select
          className="form-select form-select-sm w-auto"
          value={text(type.title)}
          disabled={!editable}
          onChange={(e) => onEdit((s) => setTypeProperty(s, name, "title", e.target.value || undefined))}
          aria-label={`${name}'s title`}
          data-testid="type-title"
        >
          <option value="">the key</option>
          {fieldNames.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {editable && (
          <button
            type="button"
            className="btn btn-ghost-danger btn-sm ms-auto"
            onClick={() => window.confirm(`Remove ${name} and its pages?`) && onEdit((s) => removeType(s, name))}
            data-testid="remove-type"
          >
            <IconTrash size={16} className="me-1" />
            Remove
          </button>
        )}
      </div>
      <CommitInput
        value={text(type.description)}
        className="form-control form-control-sm mb-2"
        placeholder="What it is, in a sentence"
        onCommit={(v) => onEdit((s) => setTypeProperty(s, name, "description", v || undefined))}
        disabled={!editable}
        ariaLabel={`${name}'s description`}
      />
      <Issues issues={typeIssues} onLine={onLine} />
      <div className="table-responsive">
        <table className="table table-sm table-vcenter mb-0">
          <thead>
            <tr>
              <th>Field</th>
              <th>Kind</th>
              <th>Label</th>
              <th title="A pipeline must give it">Required</th>
              <th title="Set by me on its page; a pipeline never writes it">Mine</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {type.fields.map(([field, def]) => {
              const own = fieldIssues(field);
              return (
                <tr key={field} data-testid="field-row" className={own.length > 0 ? "table-danger" : undefined}>
                  <td>
                    <CommitInput
                      value={field}
                      className="form-control form-control-sm font-monospace"
                      valid={(v) => ENTITY_FIELD.test(v)}
                      onCommit={(to) => onEdit((s) => renameField(s, name, field, to), renamedNote)}
                      disabled={!editable}
                      ariaLabel={`${name}.${field}'s name`}
                      testId="field-name"
                    />
                    {own.map((i) => (
                      <div key={i.path + i.message} className="small text-danger">
                        {i.message}
                        {i.line !== undefined && (
                          <button type="button" className="btn btn-link btn-sm p-0 ms-1 align-baseline" onClick={() => onLine(i.line!)}>
                            line {i.line}
                          </button>
                        )}
                      </div>
                    ))}
                  </td>
                  <td>
                    <select
                      className="form-select form-select-sm"
                      value={text(def.type)}
                      disabled={!editable}
                      onChange={(e) => onEdit((s) => setField(s, name, field, { type: e.target.value }))}
                      aria-label={`${name}.${field}'s kind`}
                      data-testid="field-kind"
                    >
                      {!(FIELD_KINDS as readonly string[]).includes(text(def.type)) && (
                        <option value={text(def.type)}>{text(def.type) || "…"}</option>
                      )}
                      {FIELD_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <CommitInput
                      value={text(def.label)}
                      className="form-control form-control-sm"
                      placeholder={field}
                      onCommit={(v) => onEdit((s) => setField(s, name, field, { label: v || undefined }))}
                      disabled={!editable}
                      ariaLabel={`${name}.${field}'s label`}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      className="form-check-input"
                      checked={def.required === true}
                      disabled={!editable}
                      onChange={(e) => onEdit((s) => setField(s, name, field, { required: e.target.checked }))}
                      aria-label={`${name}.${field} required`}
                      data-testid="field-required"
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      className="form-check-input"
                      checked={def.mine === true}
                      disabled={!editable || type.mine === true}
                      onChange={(e) => onEdit((s) => setField(s, name, field, { mine: e.target.checked }))}
                      aria-label={`${name}.${field} mine`}
                      data-testid="field-mine"
                    />
                  </td>
                  <td>
                    {def.type === "enum" && (
                      <CommitInput
                        value={Array.isArray(def.values) ? def.values.map(String).join(", ") : ""}
                        className="form-control form-control-sm"
                        placeholder="one, two"
                        onCommit={(v) =>
                          onEdit((s) =>
                            setField(s, name, field, {
                              values: v
                                .split(",")
                                .map((x) => x.trim())
                                .filter(Boolean),
                            }),
                          )
                        }
                        disabled={!editable}
                        ariaLabel={`${name}.${field}'s values`}
                        testId="field-values"
                      />
                    )}
                    {def.type === "money" && (
                      <select
                        className="form-select form-select-sm"
                        value={text(def.currency)}
                        disabled={!editable}
                        onChange={(e) => onEdit((s) => setField(s, name, field, { currency: e.target.value || undefined }))}
                        aria-label={`${name}.${field}'s currency`}
                        data-testid="field-currency"
                      >
                        <option value="">no currency field</option>
                        {def.currency !== undefined && !textFields.includes(text(def.currency)) && (
                          <option value={text(def.currency)}>{text(def.currency)}</option>
                        )}
                        {textFields.map((f) => (
                          <option key={f} value={f}>
                            currency in {f}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="text-end">
                    {editable && (
                      <button
                        type="button"
                        className="btn btn-ghost-danger btn-icon btn-sm"
                        title={`Remove ${field}`}
                        aria-label={`Remove ${name}.${field}`}
                        onClick={() => onEdit((s) => removeField(s, name, field))}
                        data-testid="remove-field"
                      >
                        <IconTrash size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {type.stages && (
              <tr className="text-secondary">
                <td>
                  <code>{text(type.stages.field)}</code>
                </td>
                <td colSpan={6}>its stage: {type.stages.states.join(", ")} (on the Stages tab)</td>
              </tr>
            )}
            {editable && (
              <tr>
                <td>
                  <input
                    className="form-control form-control-sm font-monospace"
                    placeholder="newField"
                    value={newField}
                    onChange={(e) => setNewField(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && ENTITY_FIELD.test(newField)) {
                        onEdit((s) => addField(s, name, newField, newKind));
                        setNewField("");
                      }
                    }}
                    aria-label={`New field of ${name}`}
                    data-testid="new-field-name"
                  />
                </td>
                <td>
                  <select
                    className="form-select form-select-sm"
                    value={newKind}
                    onChange={(e) => setNewKind(e.target.value)}
                    aria-label="New field's kind"
                    data-testid="new-field-kind"
                  >
                    {FIELD_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </td>
                <td colSpan={5}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!ENTITY_FIELD.test(newField)}
                    onClick={() => {
                      onEdit((s) => addField(s, name, newField, newKind));
                      setNewField("");
                    }}
                    data-testid="add-field"
                  >
                    <IconPlus size={16} className="me-1" />
                    Add a field
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The App's name, icon and description, above the tabs. */
export function AppProperties({
  app,
  icon,
  description,
  onEdit,
  editable,
}: Readonly<{ app: LooseApp; icon: string; description: string; onEdit: (edit: DesignerEdit) => void; editable: boolean }>) {
  return (
    <div className="card-body border-bottom d-flex gap-2 flex-wrap align-items-center" data-testid="app-properties">
      <CommitInput
        value={app.name ?? ""}
        className="form-control fw-bold w-auto"
        valid={(v) => APP_NAME.test(v)}
        onCommit={(v) => onEdit((s) => setAppProperty(s, "name", v))}
        disabled={!editable}
        ariaLabel="The App's name"
        testId="app-name"
      />
      <select
        className="form-select w-auto"
        value={icon}
        disabled={!editable}
        onChange={(e) => onEdit((s) => setAppProperty(s, "icon", e.target.value))}
        aria-label="The App's icon"
        data-testid="app-icon"
      >
        {!(VIEW_ICONS as readonly string[]).includes(icon) && <option value={icon}>{icon}</option>}
        {VIEW_ICONS.map((i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </select>
      <div className="flex-fill">
        <CommitInput
          value={description}
          placeholder="What it keeps, in a sentence"
          onCommit={(v) => onEdit((s) => setAppProperty(s, "description", v))}
          disabled={!editable}
          ariaLabel="The App's description"
          testId="app-description"
        />
      </div>
    </div>
  );
}

/**
 * A text the designer writes into the YAML when I'm done with it (Enter, or leaving the box), not at every key: a
 * rename halfway through would rename the pages to half a name. Escape puts back what was there.
 */
export function CommitInput({
  value,
  onCommit,
  valid = () => true,
  className,
  placeholder,
  disabled,
  ariaLabel,
  testId,
}: Readonly<{
  value: string;
  onCommit: (value: string) => void;
  valid?: (value: string) => boolean;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}>) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const ok = valid(draft.trim());
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (next === value) return;
    if (!ok) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      cancelled.current = true;
      setDraft(value);
      e.currentTarget.blur();
    }
  };
  return (
    <input
      className={`${className ?? "form-control"} ${ok ? "" : "is-invalid"}`}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={keys}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  );
}
