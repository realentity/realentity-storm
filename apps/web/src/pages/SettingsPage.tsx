import {
  EFFORTS,
  LLM_TASKS,
  RUN_LIMIT_DEFAULTS,
  type LlmTask,
  type SettingsRequest,
  type SettingsView,
  type SpendingView,
  type StepTypeView,
} from "@realentity/storm-shared";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, useLocation, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { EmailAccountsCard } from "../components/EmailAccountsCard";
import { ModelServersCard } from "../components/ModelServersCard";
import { GoogleAccountsCard } from "../components/GoogleAccountsCard";
import { TelegramCommandsCard } from "../components/TelegramCommandsCard";
import { TelegramConnectionCard } from "../components/TelegramConnectionCard";
import { ErrorAlert, Loading, PageHeader } from "../components/ui";
import { useCatalog } from "../lib/catalog";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";

const SOURCE_LABEL = { settings: "chosen here", default: "the default model", "built-in": "built-in default" } as const;

/** M60: a model on the OpenAI-compatible server. */
const OPENAI_PREFIX = "openai:";

/** M61: Settings' pages, each at /settings/<key>. */
const SECTIONS = [
  { key: "ai", label: "AI" },
  { key: "email", label: "Email" },
  { key: "google", label: "Google" },
  { key: "telegram", label: "Telegram" },
  { key: "runs", label: "Runs & browser" },
] as const;
type Section = (typeof SECTIONS)[number]["key"];

/**
 * Settings, in pages (M61): AI (model servers, model per task, the budget, spending; docs/design.md §5), Email, Google
 * (the OAuth client, the accounts), Telegram (the Storm bot, the hooks address, approvals, commands, the brief and the
 * review), Runs & browser (the run limits, global rate limits, §2.2).
 */
export function SettingsPage() {
  const { section } = useParams();
  const { hash, search } = useLocation();
  if (!SECTIONS.some((s) => s.key === section)) {
    // /settings, and the old /settings#email and #google links: to their page, the query kept (?google=…).
    const old = hash.slice(1);
    const to = SECTIONS.find((s) => s.key === old)?.key ?? "ai";
    return <Navigate to={`/settings/${to}${search}`} replace />;
  }
  return (
    <>
      <PageHeader title="Settings" />
      <ul className="nav nav-tabs mb-3" data-testid="settings-sections">
        {SECTIONS.map((s) => (
          <li key={s.key} className="nav-item">
            <NavLink to={`/settings/${s.key}`} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} data-testid={`settings-${s.key}`}>
              {s.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <SectionPage section={section as Section} />
    </>
  );
}

function SectionPage({ section }: { section: Section }) {
  if (section === "email") return <EmailAccountsCard />;
  if (section === "google") return <GoogleAccountsCard />;
  return <WithSettings section={section} />;
}

/** The pages that show the settings themselves. */
function WithSettings({ section }: { section: Exclude<Section, "email" | "google"> }) {
  const settings = useLoad(() => api.settings.get(), []);
  const spending = useLoad(() => (section === "ai" ? api.settings.spending() : Promise.resolve(undefined)), [section, settings.data?.monthlyBudgetUsd]);
  const catalog = useCatalog();
  // M63: the commands card asks again once the bot changed.
  const [botChanges, setBotChanges] = useState(0);
  if (!settings.data) return settings.error ? <ErrorAlert error={settings.error} /> : <Loading />;
  if (section === "telegram")
    return (
      <div className="d-flex flex-column gap-3" style={{ maxWidth: 820 }}>
        <TelegramConnectionCard hooksPublicUrl={settings.data.hooksPublicUrl} onChanged={() => (settings.reload(), setBotChanges((n) => n + 1))} />
        <HooksAddress settings={settings.data} onSaved={settings.reload} />
        <TelegramApprovals settings={settings.data} onSaved={settings.reload} />
        <TelegramCommandsCard key={botChanges} />
        <WeeklyReview settings={settings.data} onSaved={settings.reload} />
      </div>
    );
  if (section === "runs")
    return (
      <div className="d-flex flex-column gap-3" style={{ maxWidth: 820 }}>
        <RunLimits settings={settings.data} onSaved={settings.reload} />
        <RateLimits settings={settings.data} catalog={catalog} onSaved={settings.reload} />
      </div>
    );
  return (
    <div className="row g-3">
      <div className="col-lg-8 d-flex flex-column gap-3">
        <ModelServersCard onChanged={settings.reload} />
        <Models settings={settings.data} onSaved={settings.reload} />
        {spending.data && <Spending spending={spending.data} />}
      </div>
      <div className="col-lg-4 d-flex flex-column gap-3">
        <Budget settings={settings.data} spending={spending.data} onSaved={settings.reload} />
        <EmbeddingsCard settings={settings.data} onSaved={settings.reload} />
        <BuilderLimit settings={settings.data} onSaved={settings.reload} />
      </div>
    </div>
  );
}

/** M63: the webhooks' public address, shown on the pipeline pages (+ /<webhook id>) and offered for the bot's webhook. */
function HooksAddress({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const [value, setValue] = useState(settings.hooksPublicUrl ?? "");
  useEffect(() => setValue(settings.hooksPublicUrl ?? ""), [settings.hooksPublicUrl]);
  const url = value.trim();
  return (
    <form
      className="card"
      data-testid="hooks-address"
      onSubmit={(e) => {
        e.preventDefault();
        void action.save({ hooksPublicUrl: url || null }, url ? "The hooks address is saved" : "The hooks address is cleared");
      }}
    >
      <div className="card-header">
        <h3 className="card-title">Hooks address</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        <div className="input-group">
          <input className="form-control" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://hooks.example.com/hooks" aria-label="Hooks address" />
          <button type="submit" className="btn btn-primary" disabled={action.busy || (url !== "" && !url.startsWith("https://"))}>
            Save
          </button>
        </div>
        <div className="form-hint">
          The public address of Storm's /hooks (https), as callers reach it: a pipeline's webhook is it + /&lt;id&gt;, the bot's
          is it + /telegram (docs/self-hosting.md). Empty: the pipeline pages show only the path.
        </div>
      </div>
    </form>
  );
}

/** M63: how long run files are kept, how long a run waits in the live view, the largest download (Settings → Runs & browser). */
function RunLimits({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const initial = () => ({
    artifactsRetentionDays: String(settings.artifactsRetentionDays),
    takeoverTimeoutMinutes: String(settings.takeoverTimeoutMinutes),
    downloadMaxMb: String(settings.downloadMaxMb),
  });
  const [values, setValues] = useState(initial);
  useEffect(() => setValues(initial()), [settings.artifactsRetentionDays, settings.takeoverTimeoutMinutes, settings.downloadMaxMb]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (key: keyof typeof values) => Number(values[key]);
  const valid =
    Number.isInteger(n("artifactsRetentionDays")) && n("artifactsRetentionDays") >= 0 && n("artifactsRetentionDays") <= 3650 &&
    Number.isInteger(n("takeoverTimeoutMinutes")) && n("takeoverTimeoutMinutes") >= 1 && n("takeoverTimeoutMinutes") <= 120 &&
    Number.isInteger(n("downloadMaxMb")) && n("downloadMaxMb") >= 1 && n("downloadMaxMb") <= 500;
  const field = (key: keyof typeof values, label: string, unit: string, hint: string, min: number, max: number) => (
    <div className="mb-3">
      <label className="form-label">{label}</label>
      <div className="input-group" style={{ maxWidth: 260 }}>
        <input type="number" min={min} max={max} className="form-control" value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} aria-label={label} />
        <span className="input-group-text">{unit}</span>
      </div>
      <div className="form-hint">
        {hint} Default {RUN_LIMIT_DEFAULTS[key]} {unit}.
      </div>
    </div>
  );
  return (
    <form
      className="card"
      data-testid="run-limits"
      onSubmit={(e) => {
        e.preventDefault();
        void action.save(
          { artifactsRetentionDays: n("artifactsRetentionDays"), takeoverTimeoutMinutes: n("takeoverTimeoutMinutes"), downloadMaxMb: n("downloadMaxMb") },
          "The run limits are saved",
        );
      }}
    >
      <div className="card-header">
        <h3 className="card-title">Run limits</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        {field("artifactsRetentionDays", "Keep run files", "days", "Screenshots, traces and downloads older than this are deleted nightly; the runs stay. 0 keeps them.", 0, 3650)}
        {field("takeoverTimeoutMinutes", "Wait in the live view", "minutes", "A run waiting for you to take over gives up after this long (its step fails).", 1, 120)}
        {field("downloadMaxMb", "Largest download", "MB", "Downloads, uploads and kept files larger than this are refused.", 1, 500)}
        <button type="submit" className="btn btn-primary" disabled={action.busy || !valid}>
          Save
        </button>
      </div>
    </form>
  );
}

function useSave(onSaved: () => void) {
  const action = useAction();
  const save = async (body: SettingsRequest, message: string) => {
    const saved = await action.run(() => api.settings.update(body));
    if (!saved) return;
    toast.success(message);
    onSaved();
  };
  return { ...action, save };
}

/** M12-T4: Approve and Reject on the Storm bot's messages. */
function TelegramApprovals({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  return (
    <div className="card">
      <div className="card-body">
        <ErrorAlert error={action.error} />
        <label className="form-check form-switch mb-0">
          <input
            className="form-check-input"
            type="checkbox"
            checked={settings.telegramApprovals}
            disabled={action.busy}
            onChange={(e) =>
              void action.save(
                { telegramApprovals: e.target.checked },
                e.target.checked ? "Approvals on Telegram are on" : "Approvals on Telegram are off",
              )
            }
            data-testid="telegram-approvals"
          />
          <span className="form-check-label">Approve on Telegram</span>
          <div className="small text-secondary">
            The Storm bot's messages get Approve and Reject when the whole payload fits in the message and nothing new is targeted. Off:
            they only link here.
          </div>
        </label>
      </div>
    </div>
  );
}

/** M19-T4, M25: the weekly review and the morning brief on the Storm bot. */
function WeeklyReview({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const toggle = (field: "weeklyReview" | "morningBrief", label: string, hint: string) => (
    <label className="form-check form-switch mb-2">
      <input
        className="form-check-input"
        type="checkbox"
        checked={settings[field]}
        disabled={action.busy}
        onChange={(e) => void action.save({ [field]: e.target.checked }, `${label} is ${e.target.checked ? "on" : "off"}`)}
        data-testid={field === "weeklyReview" ? "weekly-review" : "morning-brief"}
      />
      <span className="form-check-label">{label}</span>
      <div className="small text-secondary">{hint}</div>
    </label>
  );
  return (
    <div className="card">
      <div className="card-body">
        <ErrorAlert error={action.error} />
        {toggle(
          "morningBrief",
          "Morning brief",
          "Every day at 07:30: today's calendar, what waits for you, what failed overnight, bills due soon.",
        )}
        {toggle(
          "weeklyReview",
          "Weekly review",
          "Sunday evening: the week's runs and failures, the LLM cost against the budget, what waits for you, application outcomes, broken and quiet recipes.",
        )}
      </div>
    </div>
  );
}

/** M19-T3: where the money went in the last 30 days, to choose cheaper models where quality allows. */
function Spending({ spending }: { spending: SpendingView }) {
  const share = (usd: number) => (spending.totalUsd > 0 ? Math.round((usd / spending.totalUsd) * 100) : 0);
  return (
    <div className="card" data-testid="spending">
      <div className="card-header">
        <h3 className="card-title">LLM cost, last 30 days</h3>
        <div className="card-actions text-secondary">{money(spending.totalUsd)}</div>
      </div>
      {spending.rows.length === 0 ? (
        <div className="card-body text-secondary">Nothing spent in the last 30 days.</div>
      ) : (
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Step type</th>
                <th>Model</th>
                <th className="text-end">Calls</th>
                <th className="text-end">Cost</th>
                <th className="text-end">Share</th>
              </tr>
            </thead>
            <tbody>
              {spending.rows.map((row) => (
                <tr key={`${row.source} ${row.model}`}>
                  <td>
                    <code>{row.source}</code>
                  </td>
                  <td className="text-secondary">{row.model}</td>
                  <td className="text-end">{row.calls}</td>
                  <td className="text-end">{money(row.costUsd)}</td>
                  <td className="text-end text-secondary">{share(row.costUsd)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer small text-secondary">
        reflection: the nightly reflection; builder: the pipeline chat. A step that fell back to a second model shows both.
      </div>
    </div>
  );
}

/** Two decimals, or four below a cent so small costs don't show as $0.00. */
function money(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

/** A model's name to show: "qwen3:14b · Ollama", or a Claude model's id. */
function modelLabel(settings: SettingsView, id: string): string {
  for (const server of settings.servers) {
    const model = server.models.find((m) => m.id === id);
    if (model) return server.kind === "CLAUDE" ? model.name : `${model.name} · ${server.name}`;
  }
  if (!id.startsWith(OPENAI_PREFIX)) return id;
  const server = settings.servers.find((s) => id.startsWith(`${OPENAI_PREFIX}${s.integrationId}:`));
  const name = id.split(":").slice(2).join(":");
  return server ? `${name} · ${server.name}` : `${name} · a removed server`;
}

/** The models to choose from, by server; an off server's shown but not choosable (M62). */
function ModelOptions({ settings, current }: { settings: SettingsView; current: string | null }) {
  const known = settings.servers.flatMap((s) => s.models.map((m) => m.id));
  return (
    <>
      {current && !known.includes(current) && <option value={current}>{modelLabel(settings, current)}</option>}
      {settings.servers
        .filter((s) => s.models.length > 0)
        .map((server) => (
          <optgroup key={server.integrationId} label={server.enabled ? server.name : `${server.name} (off)`}>
            {server.models.map((m) => (
              <option key={m.id} value={m.id} disabled={!server.enabled}>
                {m.name}
              </option>
            ))}
          </optgroup>
        ))}
    </>
  );
}

function Models({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const unreachable = settings.servers.filter((s) => s.error);
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Model per task</h3>
      </div>
      <ErrorAlert error={action.error} />
      {unreachable.map((server) => (
        <div key={server.integrationId} className="alert alert-warning m-3 mb-0" data-testid="server-models-error">
          The models on {server.name} couldn't be listed: {server.error}
        </div>
      ))}
      <div className="card-body border-bottom" data-testid="default-model">
        <div className="row g-2 align-items-center">
          <label className="col-auto col-form-label" htmlFor="default-model">
            Default model
          </label>
          <div className="col">
            <select
              id="default-model"
              className="form-select"
              value={settings.defaultModel ?? ""}
              disabled={action.busy}
              onChange={(e) =>
                void action.save(
                  { defaultModel: e.target.value || null },
                  e.target.value ? `Default model: ${modelLabel(settings, e.target.value)}` : "Default model: each task group's own",
                )
              }
            >
              <option value="">Each task group's own: Haiku to label, Sonnet to write, Opus for the builder</option>
              <ModelOptions settings={settings} current={settings.defaultModel} />
            </select>
          </div>
        </div>
        <div className="small text-secondary mt-1">Every task without a model of its own below uses it. A model whose server is off is passed over.</div>
      </div>
      <div className="table-responsive">
        <table className="table table-vcenter card-table" data-testid="models">
          <thead>
            <tr>
              <th>Task</th>
              <th>Model</th>
              <th>Effort</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {LLM_TASKS.map((task: LlmTask) => {
              const choice = settings.models[task];
              const set = (model: string, effort: string) =>
                void action.save({ models: { [task]: { model, effort } } }, `${task}: ${modelLabel(settings, model)} (${effort})`);
              return (
                <tr key={task}>
                  <td>
                    <code>{task}</code>
                    <div className="small text-secondary">{SOURCE_LABEL[choice.source]}</div>
                    {choice.waiting && (
                      <div className="small text-warning" data-testid={`waiting-${task}`}>
                        {modelLabel(settings, choice.waiting)} once its server is on
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      className="form-select"
                      value={choice.model}
                      disabled={action.busy}
                      onChange={(e) => set(e.target.value, choice.effort)}
                      aria-label={`${task} model`}
                    >
                      <ModelOptions settings={settings} current={choice.model} />
                    </select>
                  </td>
                  <td>
                    {choice.model.startsWith(OPENAI_PREFIX) ? (
                      // Not sent to a model on a server of your own.
                      <span className="text-secondary" title="A model on your own server gets no effort" data-testid={`no-effort-${task}`}>
                        —
                      </span>
                    ) : (
                      <select
                        className="form-select"
                        value={choice.effort}
                        disabled={action.busy}
                        onChange={(e) => set(choice.model, e.target.value)}
                        aria-label={`${task} effort`}
                      >
                        {EFFORTS.map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {choice.source === "settings" && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost-secondary"
                        disabled={action.busy}
                        onClick={() => void action.save({ models: { [task]: null } }, `${task}: back to the default`)}
                      >
                        Reset
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** M62: embeddings (examples in drafts, topics by meaning) from a model server and its model, or off. */
function EmbeddingsCard({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const servers = settings.servers.filter((s) => s.kind === "OPENAI_COMPATIBLE");
  const [serverId, setServerId] = useState(settings.embeddings?.integrationId ?? "");
  const [model, setModel] = useState(settings.embeddings?.model ?? "");
  useEffect(() => {
    setServerId(settings.embeddings?.integrationId ?? "");
    setModel(settings.embeddings?.model ?? "");
  }, [settings.embeddings?.integrationId, settings.embeddings?.model]);
  const names = servers.find((s) => s.integrationId === serverId)?.models.map((m) => m.name) ?? [];
  return (
    <form
      className="card"
      data-testid="embeddings"
      onSubmit={(e) => {
        e.preventDefault();
        void action.save(
          { embeddings: serverId && model.trim() ? { integrationId: serverId, model: model.trim() } : null },
          serverId && model.trim() ? `Embeddings: ${model.trim()}` : "Embeddings are off",
        );
      }}
    >
      <div className="card-header">
        <h3 className="card-title">Embeddings</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        <select className="form-select mb-2" value={serverId} onChange={(e) => setServerId(e.target.value)} aria-label="Embeddings server" data-testid="embeddings-server">
          <option value="">Off</option>
          {servers.map((s) => (
            <option key={s.integrationId} value={s.integrationId}>
              {s.name}
            </option>
          ))}
        </select>
        {serverId && (
          <>
            <input
              className="form-control mb-2"
              list="embedding-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="text-embedding-3-large, bge-m3"
              aria-label="Embeddings model"
              data-testid="embeddings-model"
            />
            <datalist id="embedding-models">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
        <button type="submit" className="btn btn-primary" disabled={action.busy || (serverId !== "" && !model.trim())}>
          Save
        </button>
        <div className="form-hint mt-2">
          Your past replies as examples in new drafts, and the topics' passages closest to an email by meaning. A model of 1024
          dimensions: OpenAI's text-embedding-3-large, or bge-m3 on Ollama. The text goes to that server. Off: no examples,
          and topics match by words.
        </div>
      </div>
    </form>
  );
}

/** M62: how many tokens a builder chat may use before a new one is needed. */
function BuilderLimit({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const [value, setValue] = useState(String(settings.builderChatMaxTokens));
  useEffect(() => setValue(String(settings.builderChatMaxTokens)), [settings.builderChatMaxTokens]);
  const tokens = Number(value);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void action.save({ builderChatMaxTokens: tokens }, `A builder chat stops at ${tokens.toLocaleString()} tokens`);
      }}
    >
      <div className="card-header">
        <h3 className="card-title">Builder chat limit</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        <div className="input-group">
          <input type="number" min="10000" step="10000" className="form-control" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Builder chat tokens" />
          <span className="input-group-text">tokens</span>
          <button type="submit" className="btn btn-primary" disabled={action.busy || !(tokens >= 10_000)}>
            Save
          </button>
        </div>
        <div className="form-hint">A chat stops answering once its calls used this many tokens (cached ones included); a new chat starts over.</div>
      </div>
    </form>
  );
}

function Budget({ settings, spending, onSaved }: { settings: SettingsView; spending?: SpendingView; onSaved: () => void }) {
  const action = useSave(onSaved);
  const [value, setValue] = useState(settings.monthlyBudgetUsd?.toString() ?? "");
  useEffect(() => setValue(settings.monthlyBudgetUsd?.toString() ?? ""), [settings.monthlyBudgetUsd]);
  const amount = Number(value);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void action.save({ monthlyBudgetUsd: value.trim() ? amount : null }, value.trim() ? `Budget: $${amount}/month` : "Budget cleared");
      }}
    >
      <div className="card-header">
        <h3 className="card-title">Monthly LLM budget</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        <div className="input-group">
          <span className="input-group-text">$</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            className="form-control"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="no limit"
            aria-label="Monthly budget in USD"
          />
          <button type="submit" className="btn btn-primary" disabled={action.busy || (value.trim() !== "" && !(amount > 0))}>
            Save
          </button>
        </div>
        <div className="form-hint">
          When this month's LLM cost reaches it, non-essential pipelines stop before their next LLM step. Telegram tells you at 80% and when
          it is reached. Empty: no limit.
        </div>
        {spending && <MonthSpent spending={spending} />}
      </div>
    </form>
  );
}

function MonthSpent({ spending }: { spending: SpendingView }) {
  const budget = spending.monthlyBudgetUsd;
  const percent = budget ? Math.min(100, Math.round((spending.monthSpentUsd / budget) * 100)) : null;
  return (
    <div className="mt-3" data-testid="month-spent">
      <div className="d-flex justify-content-between small">
        <span>This month</span>
        <span>
          {money(spending.monthSpentUsd)}
          {budget !== null && ` of ${money(budget)} (${percent}%)`}
        </span>
      </div>
      {percent !== null && (
        <div className="progress progress-sm mt-1">
          <div
            className={`progress-bar ${percent >= 100 ? "bg-danger" : percent >= 80 ? "bg-warning" : ""}`}
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Of the monthly budget"
          />
        </div>
      )}
    </div>
  );
}

function RateLimits({ settings, catalog, onSaved }: { settings: SettingsView; catalog: StepTypeView[]; onSaved: () => void }) {
  const action = useSave(onSaved);
  const sideEffects = catalog.filter((s) => s.sideEffect);
  const [type, setType] = useState("");
  const [limit, setLimit] = useState("10/day");
  const limits = settings.rateLimits;
  const save = (next: Record<string, string>, message: string) => void action.save({ rateLimits: next }, message);

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Global rate limits</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        <p className="text-secondary small">Caps across all pipelines, for steps that act outside Storm. Over the cap, a run waits.</p>
        {Object.keys(limits).length === 0 && <div className="text-secondary mb-2">None set.</div>}
        {Object.entries(limits).map(([stepType, value]) => (
          <div key={stepType} className="d-flex align-items-center gap-2 mb-2">
            <code className="flex-fill">{stepType}</code>
            <span>{value}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost-danger"
              title="Remove"
              disabled={action.busy}
              onClick={() => {
                const { [stepType]: _, ...rest } = limits;
                save(rest, `Removed the limit on ${stepType}`);
              }}
            >
              <IconTrash size={16} />
            </button>
          </div>
        ))}
        {sideEffects.length === 0 ? (
          <div className="small text-secondary">No side-effect steps in the catalog yet (email steps arrive with M4).</div>
        ) : (
          <form
            className="d-flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (type) save({ ...limits, [type]: limit.trim() }, `${type}: at most ${limit.trim()}`);
            }}
          >
            <select className="form-select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Step type">
              <option value="">Step…</option>
              {sideEffects.map((s) => (
                <option key={s.type} value={s.type}>
                  {s.type}
                </option>
              ))}
            </select>
            <input
              className="form-control"
              style={{ maxWidth: 110 }}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              aria-label="Limit"
            />
            <button type="submit" className="btn" disabled={action.busy || !type}>
              <IconPlus size={16} />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
