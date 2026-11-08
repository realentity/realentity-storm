import {
  CLAUDE_MODELS,
  EFFORTS,
  LLM_TASKS,
  type LlmTask,
  type SettingsRequest,
  type SettingsView,
  type SpendingView,
  type StepTypeView,
} from "@realentity/storm-shared";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { GoogleCalendarCard } from "../components/GoogleCalendarCard";
import { ErrorAlert, Loading, PageHeader } from "../components/ui";
import { useCatalog } from "../lib/catalog";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";

const SOURCE_LABEL = { settings: "chosen here", env: "from .env", default: "default" } as const;

/** Model per LLM task, the monthly LLM budget, and global rate limits for side-effect steps (docs/design.md §5, §2.2). */
export function SettingsPage() {
  const settings = useLoad(() => api.settings.get(), []);
  const spending = useLoad(() => api.settings.spending(), [settings.data?.monthlyBudgetUsd]);
  const catalog = useCatalog();
  if (!settings.data) return settings.error ? <ErrorAlert error={settings.error} /> : <Loading />;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="row g-3">
        <div className="col-lg-7">
          <div className="d-flex flex-column gap-3">
            <Models settings={settings.data} onSaved={settings.reload} />
            {spending.data && <Spending spending={spending.data} />}
          </div>
        </div>
        <div className="col-lg-5 d-flex flex-column gap-3">
          <Budget settings={settings.data} spending={spending.data} onSaved={settings.reload} />
          <GoogleCalendarCard />
          <TelegramApprovals settings={settings.data} onSaved={settings.reload} />
          <WeeklyReview settings={settings.data} onSaved={settings.reload} />
          <RateLimits settings={settings.data} catalog={catalog} onSaved={settings.reload} />
        </div>
      </div>
    </>
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
            The Storm bot's messages get Approve and Reject when the whole payload fits in the message and nothing new is targeted.
            Off: they only link here.
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

function Models({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const action = useSave(onSaved);
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Model per task</h3>
      </div>
      <ErrorAlert error={action.error} />
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
                void action.save({ models: { [task]: { model, effort } } }, `${task}: ${model} (${effort})`);
              return (
                <tr key={task}>
                  <td>
                    <code>{task}</code>
                    <div className="small text-secondary">{SOURCE_LABEL[choice.source]}</div>
                  </td>
                  <td>
                    <select
                      className="form-select"
                      value={choice.model}
                      disabled={action.busy}
                      onChange={(e) => set(e.target.value, choice.effort)}
                      aria-label={`${task} model`}
                    >
                      {!(CLAUDE_MODELS as readonly string[]).includes(choice.model) && <option value={choice.model}>{choice.model}</option>}
                      {CLAUDE_MODELS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
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
          {settings.budgetSource === "env" && "Currently from LLM_MONTHLY_BUDGET_USD. "}
          When this month's LLM cost reaches it, non-essential pipelines stop before their next LLM step. Telegram tells you at 80% and
          when it is reached. Empty: back to .env (or no limit).
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
