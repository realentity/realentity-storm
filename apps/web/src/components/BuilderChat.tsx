import { type BuilderChatView, type BuilderMessageView, type PipelineSuggestionView } from "@realentity/storm-shared";
import { IconBulb, IconDeviceFloppy, IconEye, IconPencil, IconSend } from "@tabler/icons-react";
import { useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage } from "../lib/api";
import { useCatalog } from "../lib/catalog";
import { api } from "../lib/endpoints";
import { formatUsd } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { CompileErrors, DiffList, PlanView, StepGraphView } from "./PlanView";
import { ErrorAlert, Loading } from "./ui";
import { AppProposal } from "./AppProposal";

interface BuilderChatProps {
  /** null: no chat yet; one is created with the first message. */
  chatId: string | null;
  /** The pipeline the chat is about (README §2.5); none for a new pipeline (README §2.1). */
  pipelineId?: string;
  /** M34: the App the chat is about. */
  appId?: string;
  /** M38-T5: in an editor: what it has open and what I am on, sent with each message. */
  editor?: () => { source: string; focus?: string };
  /** M38-T5: in an editor: a proposal goes into it (instead of opening the editor page). */
  onUse?: (proposal: { kind: "pipeline" | "app"; source: string }) => void;
  onCreated: (chatId: string) => void;
  /** A proposal was saved as a version. */
  onSaved?: (chat: BuilderChatView) => void;
  placeholder?: string;
}

/**
 * The builder chat: I describe or ask; the builder answers, asks back, or proposes a definition that compiled. A
 * proposal is saved (next version), dry-run or opened in the editor only when I press its button.
 */
export function BuilderChat({ chatId, pipelineId, appId, editor, onUse, onCreated, onSaved, placeholder }: BuilderChatProps) {
  const chat = useLoad(
    () => (chatId ? api.builder.get(chatId) : Promise.resolve(null)),
    [chatId],
    (signal) => signal.type === "builder" && signal.chatId === chatId,
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const action = useAction();

  const send = async (message: string, suggestionId?: string) => {
    if (!message.trim()) return;
    setSending(message);
    const answered = await action.run(async () => {
      const id = chatId ?? (await api.builder.create(pipelineId, appId)).chatId;
      if (!chatId) onCreated(id);
      return api.builder.send(id, message.trim(), suggestionId, editor?.());
    });
    setSending(null);
    if (!answered) return;
    setText("");
    chat.reload();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send(text);
  };

  const view = chat.data ?? null;
  if (chatId && !view) return chat.error ? <ErrorAlert error={chat.error} /> : <Loading />;
  const busy = sending !== null;

  return (
    <div className="d-flex flex-column gap-3" data-testid="builder-chat">
      {view && !view.available && (
        <div className="alert alert-warning mb-0">The builder needs ANTHROPIC_API_KEY in .env. Until then, edit the YAML directly.</div>
      )}
      {view && view.suggestions.length > 0 && (
        <Suggestions
          suggestions={view.suggestions}
          busy={busy}
          onApply={(s) => void send("Apply this suggestion from the reflection.", s.suggestionId)}
        />
      )}
      {view?.messages.map((message) => (
        <Message key={message.messageId} chat={view} message={message} onSaved={onSaved} onChanged={chat.reload} onUse={onUse} />
      ))}
      {sending && (
        <>
          <UserBubble text={sending} />
          <Loading label="The builder is thinking (this can take a minute)…" />
        </>
      )}
      <ErrorAlert error={action.error} />
      <div>
        <textarea
          className="form-control"
          rows={3}
          value={text}
          disabled={busy || view?.available === false}
          placeholder={placeholder ?? "Describe what the pipeline should do, or what to change"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-label="Message to the builder"
          data-testid="builder-input"
        />
        <div className="d-flex align-items-center gap-2 mt-2">
          {view && (
            <span className="small text-secondary">
              {view.model} · {formatUsd(view.costUsd)} · {Math.round((view.tokensUsed / view.tokenCap) * 100)}% of this chat's tokens
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary ms-auto"
            disabled={busy || !text.trim() || view?.available === false}
            onClick={() => void send(text)}
            data-testid="builder-send"
          >
            <IconSend size={18} className="me-1" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="d-flex justify-content-end">
      <div className="card bg-primary-lt mb-0" style={{ maxWidth: "85%" }}>
        <div className="card-body py-2 text-pre-line">{text}</div>
      </div>
    </div>
  );
}

function Message({
  chat,
  message,
  onSaved,
  onChanged,
  onUse,
}: {
  chat: BuilderChatView;
  message: BuilderMessageView;
  onSaved?: (chat: BuilderChatView) => void;
  onChanged: () => void;
  onUse?: BuilderChatProps["onUse"];
}) {
  if (message.role === "user") return <UserBubble text={message.text} />;
  return (
    <div className="d-flex flex-column gap-2" data-testid="builder-answer">
      {message.text && <div className="text-pre-line">{message.text}</div>}
      {message.error && <div className="alert alert-danger mb-0">{message.error}</div>}
      {message.compileErrors && <CompileErrors errors={message.compileErrors} title="The builder's last proposal doesn't compile" />}
      {message.proposal && <Proposal chat={chat} message={message} onSaved={onSaved} onChanged={onChanged} onUse={onUse} />}
      {message.appProposal && (
        <AppProposal chat={chat} message={message} onChanged={onChanged} onUse={onUse && ((source) => onUse({ kind: "app", source }))} />
      )}
    </div>
  );
}

function Proposal({
  chat,
  message,
  onSaved,
  onChanged,
  onUse,
}: {
  chat: BuilderChatView;
  message: BuilderMessageView;
  onSaved?: (chat: BuilderChatView) => void;
  onChanged: () => void;
  onUse?: BuilderChatProps["onUse"];
}) {
  const proposal = message.proposal!;
  const catalog = useCatalog();
  const navigate = useNavigate();
  const action = useAction();
  const [showPlan, setShowPlan] = useState(chat.currentVersion === null && proposal.status === "open");
  const next = (chat.currentVersion ?? 0) + 1;
  const open = proposal.status === "open";

  const save = async () => {
    const saved = await action.run(
      () => api.builder.save(chat.chatId, message.messageId),
      (e) => toast.error(errorMessage(e)),
    );
    if (!saved) return;
    toast.success(`Saved as v${saved.currentVersion}`);
    onChanged();
    onSaved?.(saved);
  };
  const dryRun = async () => {
    const response = await action.run(
      () => api.builder.dryRun(chat.chatId, message.messageId),
      (e) => toast.error(errorMessage(e)),
    );
    if (response) void navigate(`/runs/${response.run.runId}`);
  };
  const edit = () =>
    void navigate(chat.pipelineId ? `/pipelines/${chat.pipelineId}/edit` : "/pipelines/new", { state: { source: proposal.source } });

  return (
    <div className={`card mb-0 ${open ? "border-primary" : ""}`} data-testid="builder-proposal">
      <div className="card-header">
        <h3 className="card-title">
          Proposal
          {proposal.status === "saved" && <span className="badge bg-green-lt ms-2">saved as v{proposal.savedVersion}</span>}
          {proposal.status === "superseded" && <span className="badge bg-secondary-lt ms-2">replaced by a later proposal</span>}
        </h3>
        <div className="card-actions">
          <button type="button" className="btn btn-sm btn-ghost-secondary" onClick={() => setShowPlan((s) => !s)}>
            {showPlan ? "Hide the plan" : "Show the plan"}
          </button>
        </div>
      </div>
      <div className="card-body d-flex flex-column gap-3">
        <div className="fw-bold">{proposal.summary}</div>
        {proposal.diff && chat.currentVersion !== null && <DiffList changes={proposal.diff.changes} against={chat.currentVersion} />}
        {proposal.warnings.length > 0 && (
          <ul className="small text-secondary mb-0">
            {proposal.warnings.map((w) => (
              <li key={`${w.path}:${w.message}`}>{w.message}</li>
            ))}
          </ul>
        )}
        {showPlan && (
          <>
            <StepGraphView definition={proposal.definition} catalog={catalog} />
            <PlanView definition={proposal.definition} policy={proposal.policy} catalog={catalog} />
          </>
        )}
      </div>
      {open && (
        <div className="card-footer d-flex gap-2 flex-wrap">
          {onUse ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy}
              onClick={() => onUse({ kind: "pipeline", source: proposal.source })}
              data-testid="builder-use"
            >
              <IconPencil size={18} className="me-1" />
              Use in the editor
            </button>
          ) : (
            <button type="button" className="btn" disabled={action.busy} onClick={edit}>
              <IconPencil size={18} className="me-1" />
              Open in the editor
            </button>
          )}
          <button type="button" className="btn" disabled={action.busy} onClick={() => void dryRun()}>
            <IconEye size={18} className="me-1" />
            Dry run
          </button>
          <button
            type="button"
            className={`btn ms-auto ${onUse ? "" : "btn-primary"}`}
            disabled={action.busy}
            onClick={() => void save()}
            data-testid="builder-save"
          >
            <IconDeviceFloppy size={18} className="me-1" />
            Save as v{next}
          </button>
        </div>
      )}
      {proposal.status === "saved" && chat.pipelineId && (
        <div className="card-footer">
          <Link to={`/pipelines/${chat.pipelineId}`}>Open the pipeline</Link>
        </div>
      )}
    </div>
  );
}

function Suggestions({
  suggestions,
  busy,
  onApply,
}: {
  suggestions: PipelineSuggestionView[];
  busy: boolean;
  onApply: (suggestion: PipelineSuggestionView) => void;
}) {
  return (
    <div className="card mb-0 border-yellow" data-testid="builder-suggestions">
      <div className="card-header">
        <h3 className="card-title">
          <IconBulb size={18} className="me-1" />
          Suggested by reflection
        </h3>
      </div>
      <div className="list-group list-group-flush">
        {suggestions.map((s) => (
          <div key={s.suggestionId} className="list-group-item d-flex gap-2 align-items-start">
            <div className="flex-fill">
              <div>{s.text}</div>
              {s.rationale && <div className="small text-secondary">{s.rationale}</div>}
            </div>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onApply(s)}>
              Turn into a change
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
