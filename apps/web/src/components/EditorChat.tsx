import { IconMessagePlus, IconSparkles, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { type BuilderMarks } from "../lib/builder-marks";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";
import { BuilderChat } from "./BuilderChat";

/**
 * M38-T5: the builder beside an editor. Each message carries what the editor has open (not saved yet) and what the user
 * is on there; a proposal goes into the editor with Use, its changes marked, and is saved from the editor as any change.
 * A saved pipeline or App continues its latest chat; a new one starts a chat of its own.
 */
export function EditorChat({
  pipelineId,
  appId,
  editor,
  onUse,
  placeholder,
}: Readonly<{
  pipelineId?: string;
  appId?: string;
  editor: () => { source: string; focus?: string };
  onUse: (proposal: { kind: "pipeline" | "app"; source: string }) => void;
  placeholder: string;
}>) {
  const saved = Boolean(pipelineId ?? appId);
  const chats = useLoad(() => (saved ? api.builder.list(pipelineId, appId) : Promise.resolve([])), [pipelineId, appId]);
  // undefined: the latest chat; null: a new one (made with its first message).
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const chatId = selected === undefined ? (chats.data?.[0]?.chatId ?? null) : selected;
  const focus = editor().focus;
  return (
    <div className="card" data-testid="editor-chat">
      <div className="card-header">
        <h3 className="card-title">
          <IconSparkles size={18} className="me-1" />
          Ask the builder
        </h3>
        <div className="card-actions">
          <button type="button" className="btn btn-sm" disabled={chatId === null} onClick={() => setSelected(null)}>
            <IconMessagePlus size={16} className="me-1" />
            New chat
          </button>
        </div>
      </div>
      <div className="card-body">
        <div className="small text-secondary mb-2" data-testid="editor-chat-context">
          It sees what is open here, saved or not{focus ? `, and that you are on ${focus}` : ""}. Use puts a proposal in the editor, its
          changes marked; Undo takes it back.
        </div>
        {chats.data && (
          <BuilderChat
            chatId={chatId}
            pipelineId={pipelineId}
            appId={appId}
            editor={editor}
            onUse={onUse}
            placeholder={placeholder}
            onCreated={(id) => {
              setSelected(id);
              chats.reload();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The marks of a proposal used in the editor: what it changed, until cleared or undone. */
export function BuilderMarksBanner({ marks, onClear }: Readonly<{ marks: BuilderMarks; onClear: () => void }>) {
  return (
    <div className="alert alert-azure d-flex align-items-start gap-2 mb-3" data-testid="builder-marks">
      <IconSparkles size={18} className="mt-1 flex-shrink-0" />
      <div className="flex-fill">
        <strong>The builder&apos;s proposal is in the editor, not saved yet.</strong>{" "}
        {marks.changes.length > 0 ? `Its changes: ${marks.changes.join(", ")}.` : "It changes nothing here."}{" "}
        <span className="text-secondary">Marked where it is; Save keeps it, Undo takes it back.</span>
      </div>
      <button type="button" className="btn btn-sm btn-ghost-secondary" onClick={onClear} data-testid="builder-marks-clear">
        <IconX size={16} className="me-1" />
        Clear the marks
      </button>
    </div>
  );
}
