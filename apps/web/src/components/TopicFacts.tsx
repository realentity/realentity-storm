import { factsThatFit, type TopicChangeView, type TopicFactView, type TopicView } from "@realentity/storm-shared";
import { IconArrowBackUp, IconCheck, IconHistory, IconPencil, IconPlus } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/** From this many facts, the list can be filtered. */
const FILTER_FROM = 8;

/**
 * A topic's facts (M42-T1, docs/design.md §8.1): what is true about it, each with its source; the user edits one, says
 * it is no longer true, wrong, or belongs to another topic, and can undo each change. The brief is the description and
 * the current facts.
 */
export function TopicFacts({ topic, topics }: { topic: TopicView; topics: TopicView[] }) {
  const facts = useLoad(() => api.topics.facts(topic.topicId), [topic.topicId]);
  const changes = useLoad(() => api.topics.changes(topic.topicId), [topic.topicId]);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState(false);
  const [filter, setFilter] = useState("");
  const reload = () => {
    facts.reload();
    changes.reload();
  };
  const now = facts.data?.filter((f) => f.status !== "SUPERSEDED") ?? [];
  const before = facts.data?.filter((f) => f.status === "SUPERSEDED") ?? [];
  const words = filter.trim().toLowerCase();
  // Disputes first: they wait for the user.
  const shown = now
    .filter((f) => !words || `${f.about} ${f.statement} ${f.sourceLabel}`.toLowerCase().includes(words))
    .sort((a, b) => Number(b.status === "DISPUTED") - Number(a.status === "DISPUTED"));
  return (
    <div data-testid="topic-facts">
      <div className="d-flex align-items-center mb-2">
        <h4 className="mb-0 flex-fill">Facts</h4>
        <button type="button" className="btn btn-sm btn-ghost-secondary" onClick={() => setHistory((h) => !h)} data-testid="facts-history">
          <IconHistory size={16} className="me-1" />
          History
        </button>
        <button type="button" className="btn btn-sm btn-ghost-primary" onClick={() => setAdding(true)} data-testid="fact-add">
          <IconPlus size={16} className="me-1" />
          Add
        </button>
      </div>
      <ErrorAlert error={facts.error ?? changes.error} />
      {adding && (
        <FactForm
          fact={null}
          onSave={(body) => api.topics.addFact(topic.topicId, body)}
          onDone={(saved) => {
            setAdding(false);
            if (saved) reload();
          }}
        />
      )}
      {facts.data && now.length === 0 && !adding && (
        <p className="text-secondary small">
          Nothing yet. Storm proposes facts from the topic&apos;s emails, and you approve them; you can also write one.
        </p>
      )}
      {now.length >= FILTER_FROM && (
        <input
          className="form-control mb-2"
          placeholder="Find a fact"
          aria-label="Find a fact"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {now.length > 0 && shown.length === 0 && <p className="text-secondary small">No fact matches.</p>}
      {shown.length > 0 && (
        <div className="list-group mb-2">
          {shown.map((fact) => (
            <FactRow key={fact.topicFactId} fact={fact} topics={topics} onChange={reload} />
          ))}
        </div>
      )}
      <RoomNote topic={topic} facts={now} />
      {history && <History before={before} changes={changes.data ?? []} onChange={reload} />}
    </div>
  );
}

/** When not all current facts fit in a draft (M44-T7): which ones it takes, and what the user can do. */
function RoomNote({ topic, facts }: { topic: TopicView; facts: TopicFactView[] }) {
  const current = facts.filter((f) => f.status === "CURRENT");
  const fit = factsThatFit(topic.description, current);
  if (fit >= current.length) return null;
  return (
    <p className="text-secondary small" data-testid="facts-room">
      A draft has room for about {fit} of these {current.length} facts. It takes the ones you wrote or confirmed first, then those closest
      to the email it answers. To keep more of them in every draft, say which are no longer true, or split the topic; the weekly tidy-up
      (Tidy up topics&apos; facts, on the Topics page) proposes merges and retirements for you to approve.
    </p>
  );
}

function FactRow({ fact, topics, onChange }: { fact: TopicFactView; topics: TopicView[]; onChange: () => void }) {
  const [mode, setMode] = useState<"edit" | "later" | null>(null);
  const action = useAction();
  const run = async (work: () => Promise<unknown>) => {
    if (await action.run(async () => (await work(), true))) onChange();
  };
  const others = topics.filter((t) => t.topicId !== fact.topicId && t.status === "ACTIVE");

  if (mode === "edit")
    return (
      <div className="list-group-item">
        <FactForm
          fact={fact}
          onSave={(body) => api.topicFacts.edit(fact.topicFactId, body)}
          onDone={(saved) => {
            setMode(null);
            if (saved) onChange();
          }}
        />
      </div>
    );
  return (
    <div className="list-group-item py-2" data-testid={`fact-${fact.about}`}>
      <ErrorAlert error={action.error} />
      <div className="d-flex align-items-start gap-2">
        <div className="flex-fill overflow-hidden">
          <div>
            <span className="fw-bold">{fact.about}:</span> {fact.statement}
            {fact.status === "DISPUTED" && <span className="badge bg-orange-lt ms-2">in dispute</span>}
            {fact.pinned && fact.source !== "USER" && <span className="badge bg-green-lt ms-2">confirmed</span>}
          </div>
          <div className="small text-secondary text-truncate" title={fact.quote || undefined}>
            {fact.source === "USER" ? "written by you" : `from ${fact.sourceLabel}`} · {day(fact.sourceDate)}
            {fact.quote && <> · “{fact.quote}”</>}
          </div>
        </div>
        <div className="d-flex gap-1 flex-shrink-0">
          {fact.status === "DISPUTED" && (
            <button
              type="button"
              className="btn btn-sm btn-success"
              disabled={action.busy}
              title="This one holds: the others in dispute are superseded by it"
              onClick={() => void run(() => api.topicFacts.settle(fact.topicFactId))}
            >
              <IconCheck size={16} className="me-1" />
              Holds
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost-secondary"
            aria-label="Edit"
            title="Edit: the wording or value was off"
            onClick={() => setMode("edit")}
          >
            <IconPencil size={16} />
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title="No longer true: it was, things changed (kept in the history)"
            disabled={action.busy}
            onClick={() => setMode(mode === "later" ? null : "later")}
          >
            No longer true
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost-danger"
            title="Wrong: it never was (not proposed again from this source)"
            disabled={action.busy}
            onClick={() => {
              if (
                window.confirm(
                  `Mark "${fact.about}: ${fact.statement}" wrong? It is hidden and not proposed again from its source; Undo is in the History.`,
                )
              ) {
                void run(() => api.topicFacts.wrong(fact.topicFactId));
              }
            }}
          >
            Wrong
          </button>
          {others.length > 0 && (
            <select
              className="form-select form-select-sm w-auto"
              aria-label="Move to"
              value=""
              disabled={action.busy}
              onChange={(e) => {
                const target = e.target.value;
                if (target) void run(() => api.topicFacts.move(fact.topicFactId, target));
              }}
            >
              <option value="">Move to…</option>
              {others.map((t) => (
                <option key={t.topicId} value={t.topicId}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {mode === "later" && (
        <NowTrue
          busy={action.busy}
          onSave={(statement) => {
            setMode(null);
            void run(() => api.topicFacts.noLongerTrue(fact.topicFactId, statement ? { statement } : {}));
          }}
          onCancel={() => setMode(null)}
        />
      )}
    </div>
  );
}

/** "No longer true": what is true now, if the user knows it. */
function NowTrue({ busy, onSave, onCancel }: { busy: boolean; onSave: (statement: string) => void; onCancel: () => void }) {
  const [statement, setStatement] = useState("");
  return (
    <form
      className="d-flex gap-2 mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(statement.trim());
      }}
    >
      <input
        className="form-control form-control-sm"
        placeholder="What is true now (optional)"
        aria-label="What is true now"
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
      />
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
        Save
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function FactForm({
  fact,
  onSave,
  onDone,
}: {
  fact: TopicFactView | null;
  onSave: (body: { about: string; statement: string }) => Promise<TopicFactView>;
  onDone: (saved: boolean) => void;
}) {
  const [about, setAbout] = useState(fact?.about ?? "");
  const [statement, setStatement] = useState(fact?.statement ?? "");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await action.run(() => onSave({ about, statement }))) onDone(true);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="mb-2" data-testid="fact-form">
      <ErrorAlert error={action.error} title="Not saved" />
      <div className="row g-2">
        <div className="col-sm-4">
          <input
            className="form-control"
            placeholder="Launch date"
            aria-label="About"
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            required
          />
        </div>
        <div className="col-sm-5">
          <input
            className="form-control"
            placeholder="March 2027"
            aria-label="Statement"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            required
          />
        </div>
        <div className="col-sm-3 d-flex gap-2">
          <button type="submit" className="btn btn-primary flex-fill" disabled={action.busy}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancel
          </button>
        </div>
      </div>
      <div className="form-hint">What it is about, and what is true. Yours is kept as written: Storm only proposes changes to it.</div>
    </form>
  );
}

/** What was true before, and every change to the topic's facts, each undoable while nothing later builds on it. */
function History({ before, changes, onChange }: { before: TopicFactView[]; changes: TopicChangeView[]; onChange: () => void }) {
  const action = useAction();
  const undo = async (change: TopicChangeView) => {
    if (await action.run(async () => (await api.topicFacts.undo(change.topicChangeId), true))) onChange();
  };
  return (
    <div className="mb-2" data-testid="topic-history">
      <ErrorAlert error={action.error} title="Not undone" />
      {before.length > 0 && (
        <div className="list-group mb-2">
          {before.map((fact) => (
            <div key={fact.topicFactId} className="list-group-item py-2 text-secondary">
              <s>
                {fact.about}: {fact.statement}
              </s>
              <span className="small">
                {" "}
                · {fact.source === "USER" ? "you" : fact.sourceLabel}, {day(fact.sourceDate)}
              </span>
            </div>
          ))}
        </div>
      )}
      {changes.length === 0 && <p className="text-secondary small">No changes yet.</p>}
      {changes.length > 0 && (
        <div className="list-group">
          {changes.map((change) => (
            <div key={change.topicChangeId} className="list-group-item d-flex align-items-center gap-2 py-2">
              <div className="flex-fill">
                <span className={change.undone ? "text-decoration-line-through text-secondary" : ""}>{change.summary}</span>
                <div className="small text-secondary">
                  {formatDateTime(change.dateCreated)} · {change.byRun ? "approved from a run" : "by you"}
                  {change.undone && " · undone"}
                </div>
              </div>
              {!change.undone && (
                <button type="button" className="btn btn-sm btn-ghost-secondary" disabled={action.busy} onClick={() => void undo(change)}>
                  <IconArrowBackUp size={16} className="me-1" />
                  Undo
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The date of a source: the day is enough. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
