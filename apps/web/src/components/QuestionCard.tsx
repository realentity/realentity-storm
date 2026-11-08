import { type QuestionView } from "@realentity/storm-shared";
import { IconMessageQuestion } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/** A question the run waits for the user to answer (M15-T3): here or by replying on Telegram; the answer becomes a fact. */
export function QuestionCard({ question, onAnswered }: { question: QuestionView; onAnswered: () => void }) {
  const [answer, setAnswer] = useState("");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const done = await action.run(() => api.questions.answer(question.questionId, answer.trim()));
    if (!done) return;
    toast.success("Answered: kept as a fact; the run goes on");
    onAnswered();
  };
  return (
    <div className="card mb-3 border-warning" data-testid="question">
      <div className="card-header">
        <h3 className="card-title">
          <IconMessageQuestion size={18} className="me-1" />
          The run asks you{question.site ? ` (a form on ${question.site})` : ""}
        </h3>
      </div>
      <form className="card-body" onSubmit={(e) => void submit(e)}>
        <ErrorAlert error={action.error} title="Not taken" />
        <label className="form-label fw-bold" htmlFor="question-answer">
          {question.question}
        </label>
        {question.options.length > 0 ? (
          <select id="question-answer" className="form-select" value={answer} onChange={(e) => setAnswer(e.target.value)} required>
            <option value="">Choose…</option>
            {question.options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : (
          <input id="question-answer" className="form-control" value={answer} onChange={(e) => setAnswer(e.target.value)} required autoFocus />
        )}
        <div className="form-hint">Kept as a fact (Profile page), so the next form with this question doesn&apos;t ask again. Or reply on Telegram.</div>
        <div className="mt-3 d-flex justify-content-end">
          <button type="submit" className="btn btn-primary" disabled={action.busy || !answer.trim()}>
            Answer
          </button>
        </div>
      </form>
    </div>
  );
}
