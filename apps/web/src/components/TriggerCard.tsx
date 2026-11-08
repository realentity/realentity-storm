import { APPLICATION_STATUSES, setTrigger, TRIGGER_EVENTS, type CompileIssue } from "@realentity/storm-shared";
import { IconBolt } from "@tabler/icons-react";
import { readCron, WEEKDAYS, writeCron } from "../lib/cron";
import { type TriggerTypes } from "../lib/step-cards";
import { HELP } from "../lib/help";
import { CommitInput, type DesignerEdit } from "./TypesDesigner";

type Kind = "manual" | "schedule" | "event" | "webhook";

/** What each event is, as a choice. view.action is M27's, on its way out with the old pages. */
const EVENTS: Record<string, string> = {
  "run.finished": "another pipeline's run finished",
  "application.status": "a job application moved on",
  "email.classified": "an email was labelled by email.classify",
  "recipe.broken": "a site's recipe broke",
  "flow.later": "another pipeline's flow.later came due",
  "entity.changed": "an entity of the App was added or changed",
  "entity.action": "an entity's button on its page",
};

const kindOf = (trigger: unknown): Kind => {
  if (trigger === undefined || trigger === "manual") return "manual";
  if (trigger && typeof trigger === "object") {
    if ("schedule" in trigger) return "schedule";
    if ("on" in trigger) return "event";
    if ("webhook" in trigger) return "webhook";
  }
  return "manual";
};

/**
 * M36-T2: the trigger card: by hand, on a schedule (days and times; a cron that isn't is kept and shown as written),
 * on an event (with what narrows it: the App's types and fields for an entity's), or a call from the Internet.
 */
export function TriggerCard({
  trigger,
  onEdit,
  editable,
  issues,
  types,
  pipelines,
}: Readonly<{
  trigger: unknown;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
  issues: CompileIssue[];
  types: TriggerTypes;
  pipelines: string[];
}>) {
  const kind = kindOf(trigger);
  const value = (trigger && typeof trigger === "object" ? trigger : {}) as Record<string, unknown>;
  const set = (next: unknown) => onEdit((s) => setTrigger(s, next));
  const change = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete next[key];
    else next[key] = v;
    set(next);
  };
  const choose = (k: Kind) => {
    if (k === kind) return;
    if (k === "manual") set("manual");
    if (k === "schedule") set({ schedule: "0 8 * * *", tz: "Europe/Sofia" });
    if (k === "event") set({ on: "run.finished", pipeline: pipelines[0] ?? "" });
    if (k === "webhook") set({ webhook: "token" });
  };

  return (
    <div className={`card ${issues.length ? "border-danger" : ""}`} data-testid="trigger-card">
      <div className="card-body">
        <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
          <IconBolt size={18} className="text-yellow" />
          <strong>Starts</strong>
          <div className="btn-group" role="group">
            {(
              [
                ["manual", "by hand"],
                ["schedule", "on a schedule"],
                ["event", "on an event"],
                ["webhook", "from the Internet"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`btn btn-sm ${kind === k ? "btn-primary" : ""}`}
                disabled={!editable}
                onClick={() => choose(k)}
                title={HELP.triggerKind}
                data-testid={`trigger-${k}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {kind === "schedule" && <Schedule value={value} onChange={change} disabled={!editable} />}
        {kind === "event" && <Event value={value} onSet={set} onChange={change} disabled={!editable} types={types} pipelines={pipelines} />}
        {kind === "webhook" && (
          <div className="d-flex gap-2 align-items-center small">
            <span>Checked by</span>
            <select
              className="form-select form-select-sm w-auto"
              value={String(value.webhook)}
              disabled={!editable}
              onChange={(e) => change("webhook", e.target.value)}
              title={HELP.webhookCheck}
              aria-label="How a call is checked"
            >
              <option value="token">a bearer token</option>
              <option value="hmac-sha256">a signature of the body (GitHub style)</option>
            </select>
            <span className="text-secondary">The body is {"{{trigger.body}}"}.</span>
          </div>
        )}
        {issues.map((i) => (
          <div key={i.path + i.message} className="text-danger small mt-1" data-testid="card-issue">
            {i.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function Schedule({
  value,
  onChange,
  disabled,
}: Readonly<{ value: Record<string, unknown>; onChange: (key: string, v: unknown) => void; disabled: boolean }>) {
  const cron = typeof value.schedule === "string" ? value.schedule : "";
  const simple = readCron(cron);
  const tz = typeof value.tz === "string" ? value.tz : "Europe/Sofia";
  return (
    <div className="d-flex flex-column gap-2 small">
      {simple ? (
        <>
          <div className="d-flex gap-1 align-items-center flex-wrap">
            <span className="me-1">On</span>
            {WEEKDAYS.map((day, n) => (
              <button
                key={day}
                type="button"
                className={`btn btn-sm px-2 ${simple.days.includes(n) ? "btn-primary" : ""}`}
                disabled={disabled}
                onClick={() => {
                  const days = simple.days.includes(n) ? simple.days.filter((d) => d !== n) : [...simple.days, n];
                  if (days.length > 0) onChange("schedule", writeCron({ ...simple, days }));
                }}
                data-testid={`day-${day}`}
              >
                {day}
              </button>
            ))}
          </div>
          <div className="d-flex gap-2 align-items-center flex-wrap">
            <span>at</span>
            <CommitInput
              value={simple.times.join(", ")}
              className="form-control form-control-sm w-auto"
              placeholder="08:00, 18:00"
              valid={(v) => v.split(",").every((t) => /^\s*([01]?\d|2[0-3]):[0-5]\d\s*$/.test(t))}
              onCommit={(v) => onChange("schedule", writeCron({ ...simple, times: v.split(",").map((t) => t.trim().padStart(5, "0")) }))}
              disabled={disabled}
              ariaLabel="Times"
              help={HELP.scheduleTimes}
              testId="schedule-times"
            />
            <span className="text-secondary">(the same minute for each: a cron has one)</span>
          </div>
        </>
      ) : (
        <div className="text-secondary">A schedule the card can&apos;t show as days and times, kept as written:</div>
      )}
      <div className="d-flex gap-2 align-items-center flex-wrap">
        <span>cron</span>
        <CommitInput
          value={cron}
          className="form-control form-control-sm font-monospace w-auto"
          onCommit={(v) => onChange("schedule", v)}
          disabled={disabled}
          ariaLabel="Cron"
          help={HELP.scheduleCron}
          testId="schedule-cron"
        />
        <span>in</span>
        <CommitInput
          value={tz}
          className="form-control form-control-sm w-auto"
          onCommit={(v) => onChange("tz", v)}
          disabled={disabled}
          help={HELP.scheduleTz}
          ariaLabel="Time zone"
        />
      </div>
    </div>
  );
}

function Event({
  value,
  onSet,
  onChange,
  disabled,
  types,
  pipelines,
}: Readonly<{
  value: Record<string, unknown>;
  onSet: (trigger: unknown) => void;
  onChange: (key: string, v: unknown) => void;
  disabled: boolean;
  types: TriggerTypes;
  pipelines: string[];
}>) {
  const on = String(value.on);
  const typeNames = Object.keys(types);
  const type = typeof value.type === "string" ? value.type : "";
  const select = (key: string, options: string[], label: string, empty?: string) => (
    <select
      className="form-select form-select-sm w-auto"
      value={typeof value[key] === "string" ? value[key] : ""}
      disabled={disabled}
      onChange={(e) => onChange(key, e.target.value || undefined)}
      aria-label={label}
      title={HELP.eventOption}
      data-testid={`event-${key}`}
    >
      {empty !== undefined && <option value="">{empty}</option>}
      {typeof value[key] === "string" && !options.includes(value[key]) && <option value={value[key]}>{value[key]}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
  const many = (key: string, options: readonly string[]) => {
    const chosen = Array.isArray(value[key]) ? (value[key] as unknown[]).map(String) : [];
    return (
      <span className="d-inline-flex gap-1 flex-wrap">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`btn btn-sm px-2 ${chosen.includes(o) ? "btn-primary" : ""}`}
            disabled={disabled}
            onClick={() => onChange(key, chosen.includes(o) ? chosen.filter((c) => c !== o) : [...chosen, o])}
          >
            {o}
          </button>
        ))}
      </span>
    );
  };
  return (
    <div className="d-flex flex-column gap-2 small">
      <select
        className="form-select form-select-sm"
        value={on}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "entity.changed") onSet({ on: next, type: typeNames[0] ?? "" });
          else if (next === "run.finished") onSet({ on: next, pipeline: pipelines[0] ?? "" });
          else onSet({ on: next });
        }}
        aria-label="Which event"
        title={HELP.eventOn}
        data-testid="event-on"
      >
        {!(TRIGGER_EVENTS as readonly string[]).includes(on) && <option value={on}>{on}</option>}
        {Object.entries(EVENTS).map(([event, label]) => (
          <option key={event} value={event}>
            {label} ({event})
          </option>
        ))}
        {on === "view.action" && <option value="view.action">a row&apos;s button on a pipeline&apos;s page (view.action)</option>}
      </select>
      {on === "run.finished" && (
        <div className="d-flex gap-2 align-items-center flex-wrap">
          <span>of</span>
          {select("pipeline", pipelines, "Which pipeline")}
          <span>when it</span>
          {many("status", ["DONE", "FAILED"])}
          <span className="text-secondary">(none chosen: DONE)</span>
        </div>
      )}
      {on === "application.status" && (
        <div className="d-flex gap-2 align-items-center flex-wrap">
          <span>to</span>
          {many("status", APPLICATION_STATUSES)}
        </div>
      )}
      {on === "email.classified" && (
        <div className="d-flex gap-2 align-items-center flex-wrap">
          <span>labelled</span>
          <CommitInput
            value={Array.isArray(value.label) ? (value.label as unknown[]).map(String).join(", ") : ""}
            className="form-control form-control-sm w-auto"
            placeholder="any label"
            onCommit={(v) =>
              onChange(
                "label",
                v
                  .split(",")
                  .map((l) => l.trim())
                  .filter(Boolean),
              )
            }
            disabled={disabled}
            help={HELP.eventLabels}
            ariaLabel="Labels"
          />
        </div>
      )}
      {on === "recipe.broken" && (
        <div className="d-flex gap-2 align-items-center">
          <span>for the site</span>
          <CommitInput
            value={typeof value.site === "string" ? value.site : ""}
            className="form-control form-control-sm w-auto"
            placeholder="any site"
            onCommit={(v) => onChange("site", v)}
            disabled={disabled}
            help={HELP.eventSite}
            ariaLabel="Site"
          />
        </div>
      )}
      {(on === "entity.changed" || on === "entity.action") && (
        <div className="d-flex gap-2 align-items-center flex-wrap">
          {typeNames.length === 0 && <span className="text-warning">The pipeline names no App with types: set its App above.</span>}
          <span>a</span>
          {select("type", typeNames, "Which type", on === "entity.action" ? "any type" : undefined)}
          {on === "entity.changed" && type && (
            <>
              <span>when</span>
              {select("field", types[type]?.fields ?? [], "Which field", "anything")}
              <span>changes</span>
              {(types[type]?.states.length ?? 0) > 0 && (
                <>
                  <span>, moving to</span>
                  {select("stage", types[type].states, "Which stage", "any stage")}
                </>
              )}
            </>
          )}
          <span className="text-secondary w-100">The entity is {"{{trigger.item}}"}.</span>
        </div>
      )}
      {on === "flow.later" && <span className="text-secondary">With the data the other pipeline gave: {"{{trigger.data}}"}.</span>}
    </div>
  );
}
