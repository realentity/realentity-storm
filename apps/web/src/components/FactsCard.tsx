import { type FactView } from "@realentity/storm-shared";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { Empty, ErrorAlert, Loading } from "./ui";

const SOURCE = { FORM: "from a form I approved", ASKED: "I answered when asked", ME: "written here" } as const;

/**
 * My facts (M15-T1): what application forms asked that only I can say, and my answers. Forms reuse them word for
 * word before writing anything new; only my approvals, my answers and this card write them.
 */
export function FactsCard() {
  const facts = useLoad(() => api.facts.list(), []);
  const action = useAction();
  const [editing, setEditing] = useState<FactView | "new" | null>(null);
  const remove = async (fact: FactView) => {
    const done = await action.run(async () => {
      await api.facts.remove(fact.factId);
      return true;
    });
    if (done) facts.reload();
  };
  return (
    <div className="card" data-testid="facts">
      <div className="card-header">
        <h3 className="card-title">Facts</h3>
        <div className="card-actions">
          <button type="button" className="btn btn-sm" onClick={() => setEditing("new")} data-testid="fact-add">
            <IconPlus size={16} className="me-1" />
            Add
          </button>
        </div>
      </div>
      <div className="card-body">
        <p className="text-secondary small">
          What forms asked that your profile doesn&apos;t say (salary, notice period, relocation…): the answers you gave or approved. Forms reuse
          them word for word, and ask you only what isn&apos;t here.
        </p>
        <ErrorAlert error={facts.error ?? action.error} />
        {!facts.data && facts.loading && <Loading />}
        {facts.data?.length === 0 && <Empty>No facts yet: they come from the forms you approve and the questions you answer.</Empty>}
        {editing && (
          <FactForm
            fact={editing === "new" ? null : editing}
            onDone={() => {
              setEditing(null);
              facts.reload();
            }}
          />
        )}
      </div>
      {facts.data && facts.data.length > 0 && (
        <div className="list-group list-group-flush">
          {facts.data.map((fact) => (
            <div className="list-group-item" key={fact.factId} data-testid={`fact-${fact.question}`}>
              <div className="d-flex gap-2 align-items-start">
                <div className="flex-fill">
                  <div className="fw-bold">{fact.question}</div>
                  <div>{fact.answer}</div>
                  <div className="small text-secondary">
                    {SOURCE[fact.source]}
                    {fact.site && ` on ${fact.site}`} · {formatDateTime(fact.dateUpdated)}
                    {fact.uses > 0 && ` · used ${fact.uses}×, last ${formatDateTime(fact.lastUsedAt)}`}
                  </div>
                </div>
                <button type="button" className="btn btn-sm btn-ghost-secondary" aria-label="Edit" onClick={() => setEditing(fact)}>
                  <IconPencil size={16} />
                </button>
                <button type="button" className="btn btn-sm btn-ghost-danger" aria-label="Delete" disabled={action.busy} onClick={() => void remove(fact)}>
                  <IconTrash size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FactForm({ fact, onDone }: { fact: FactView | null; onDone: () => void }) {
  const [question, setQuestion] = useState(fact?.question ?? "");
  const [answer, setAnswer] = useState(fact?.answer ?? "");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = { question: question.trim(), answer: answer.trim() };
    const saved = await action.run(() => (fact ? api.facts.update(fact.factId, body) : api.facts.create(body)));
    if (!saved) return;
    toast.success("Fact saved");
    onDone();
  };
  return (
    <form className="border rounded p-3 mb-3" onSubmit={(e) => void submit(e)} data-testid="fact-form">
      <ErrorAlert error={action.error} title="Not saved" />
      <div className="mb-2">
        <label className="form-label required" htmlFor="fact-question">
          Question
        </label>
        <input id="fact-question" className="form-control" placeholder="Salary expectation" value={question} onChange={(e) => setQuestion(e.target.value)} required />
      </div>
      <div className="mb-2">
        <label className="form-label required" htmlFor="fact-answer">
          Answer
        </label>
        <input id="fact-answer" className="form-control" placeholder="4 000 EUR net per month" value={answer} onChange={(e) => setAnswer(e.target.value)} required />
      </div>
      <div className="d-flex gap-2 justify-content-end">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={action.busy}>
          Save
        </button>
      </div>
    </form>
  );
}
