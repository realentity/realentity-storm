import { type JsonSchema } from "@realentity/storm-shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { parse, stringify } from "yaml";
import { fieldKind, resolve } from "../lib/schema-form";
import { HELP } from "../lib/help";
import { CommitInput } from "./TypesDesigner";

/**
 * M36-T3: a step's inputs as a form from its JSON Schema: one generator for every step, nothing per step. Text,
 * numbers, yes/no, choices and lists of text get their own fields; lists of objects, objects and anything else are
 * YAML in a box. A value the form can't show as its kind (a {{template}} in a number) is shown as text, as written.
 */

/** A single {{reference}}: the value is whatever it refers to. */
const WHOLE = /^\{\{\s*[^{}]+?\s*\}\}$/;

const isTemplate = (value: unknown) => typeof value === "string" && value.includes("{{");

export function SchemaField({
  name,
  schema,
  value,
  required,
  onChange,
  disabled,
  extra,
  testId,
}: Readonly<{
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** Next to the field: the data picker, a credential. */
  extra?: ReactNode;
  testId?: string;
}>) {
  const s = resolve(schema);
  const kind = fieldKind(name, schema);
  const help = s.description ?? HELP.stepInput;
  const id = `field-${name}`;
  const shown = value === undefined && s.default !== undefined ? `default ${JSON.stringify(s.default)}` : undefined;
  const label = (
    <label className="form-label mb-1 d-flex align-items-center gap-2" htmlFor={id}>
      <code>{name}</code>
      {required && <span className="text-danger small">needed</span>}
      {s.description && <span className="text-secondary small fw-normal">{s.description}</span>}
      <span className="ms-auto d-flex gap-1">{extra}</span>
    </label>
  );

  // A template where the form expects a number, a choice or yes/no: as text, left as written.
  const asText = isTemplate(value) && kind !== "text" && kind !== "long" && kind !== "code";
  let field: ReactNode;
  if (asText || kind === "text") {
    field = (
      <CommitInput
        value={typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : ""}
        placeholder={shown}
        className="form-control form-control-sm"
        onCommit={(v) => onChange(v === "" ? undefined : v)}
        disabled={disabled}
        help={help}
        ariaLabel={name}
        testId={testId}
      />
    );
  } else if (kind === "enum") {
    field = (
      <select
        id={id}
        className="form-select form-select-sm"
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        title={help}
        aria-label={name}
        data-testid={testId}
      >
        <option value="">{shown ?? (required ? "…" : "(not set)")}</option>
        {(s.enum as string[]).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  } else if (kind === "boolean") {
    field = (
      <select
        id={id}
        className="form-select form-select-sm w-auto"
        value={value === true ? "yes" : value === false ? "no" : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "yes")}
        title={help}
        aria-label={name}
        data-testid={testId}
      >
        <option value="">{shown ?? "(not set)"}</option>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    );
  } else if (kind === "number") {
    field = (
      <CommitInput
        value={typeof value === "number" ? String(value) : ""}
        placeholder={shown}
        className="form-control form-control-sm w-auto"
        valid={(v) => v === "" || Number.isFinite(Number(v))}
        onCommit={(v) => onChange(v === "" ? undefined : Number(v))}
        disabled={disabled}
        help={help}
        ariaLabel={name}
        testId={testId}
      />
    );
  } else if (kind === "lines") {
    field = (
      <CommitArea
        value={Array.isArray(value) ? value.map(String).join("\n") : ""}
        placeholder={shown ?? "one a line"}
        rows={Math.min(6, Math.max(2, Array.isArray(value) ? value.length + 1 : 2))}
        onCommit={(v) => {
          // One {{reference}} is the list itself, not a list of one.
          if (WHOLE.test(v.trim())) return onChange(v.trim());
          const lines = v
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          onChange(lines.length ? lines : undefined);
        }}
        disabled={disabled}
        help={help}
        ariaLabel={name}
        testId={testId}
      />
    );
  } else if (kind === "long" || kind === "code") {
    field = (
      <CommitArea
        value={typeof value === "string" ? value : ""}
        placeholder={shown}
        rows={kind === "code" ? 4 : 3}
        mono={kind === "code"}
        onCommit={(v) => onChange(v === "" ? undefined : v)}
        disabled={disabled}
        help={help}
        ariaLabel={name}
        testId={testId}
      />
    );
  } else {
    field = <YamlField value={value} placeholder={shown} onChange={onChange} disabled={disabled} name={name} testId={testId} help={help} />;
  }
  return (
    <div className="mb-2" data-testid="step-input" data-input={name}>
      {label}
      {field}
    </div>
  );
}

/** Lists of objects, objects, anything else: YAML in a box, read on leaving it. */
function YamlField({
  value,
  onChange,
  disabled,
  placeholder,
  name,
  testId,
  help,
}: Readonly<{
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  name: string;
  testId?: string;
  help?: string;
}>) {
  const text = value === undefined ? "" : typeof value === "string" ? value : stringify(value, { lineWidth: 0 }).trimEnd();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <CommitArea
        value={text}
        placeholder={placeholder ?? "YAML"}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        mono
        invalid={error !== null}
        onCommit={(v) => {
          if (v.trim() === "") {
            setError(null);
            onChange(undefined);
            return;
          }
          // One {{reference}} is the value itself: YAML would read its braces as a map.
          if (WHOLE.test(v.trim())) {
            setError(null);
            onChange(v.trim());
            return;
          }
          try {
            onChange(parse(v) as unknown);
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message.split("\n")[0] : "Not YAML");
          }
        }}
        disabled={disabled}
        help={help}
        ariaLabel={name}
        testId={testId}
      />
      {error && <div className="invalid-feedback d-block">{error}</div>}
    </>
  );
}

/** A box written on leaving it, as CommitInput; Escape puts back what was there. */
export function CommitArea({
  value,
  onCommit,
  rows,
  mono,
  invalid,
  placeholder,
  disabled,
  ariaLabel,
  testId,
  help,
}: Readonly<{
  value: string;
  onCommit: (value: string) => void;
  rows: number;
  mono?: boolean;
  invalid?: boolean;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
  /** M38-T3: what it is for, as its tooltip. */
  help?: string;
}>) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className={`form-control form-control-sm ${mono ? "font-monospace" : ""} ${invalid ? "is-invalid" : ""}`}
      rows={rows}
      spellCheck={!mono}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      aria-label={ariaLabel}
      title={help}
      data-testid={testId}
    />
  );
}
