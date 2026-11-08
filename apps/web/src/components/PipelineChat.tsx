import { type BuilderChatView } from "@realentity/storm-shared";
import { IconMessagePlus } from "@tabler/icons-react";
import { useState } from "react";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";
import { BuilderChat } from "./BuilderChat";

/** The pipeline page's chat (docs/design.md §2.5): its latest chat, or a new one; older chats stay selectable. */
export function PipelineChat({ pipelineId, onSaved }: { pipelineId: string; onSaved: (chat: BuilderChatView) => void }) {
  const chats = useLoad(() => api.builder.list(pipelineId), [pipelineId]);
  // undefined: the latest chat; null: a new chat (created with its first message).
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const chatId = selected === undefined ? (chats.data?.[0]?.chatId ?? null) : selected;

  return (
    <div className="card" data-testid="pipeline-chat">
      <div className="card-header">
        <h3 className="card-title">Change it in chat</h3>
        <div className="card-actions d-flex gap-2">
          {chats.data && chats.data.length > 1 && (
            <select
              className="form-select form-select-sm"
              value={chatId ?? ""}
              onChange={(e) => setSelected(e.target.value || null)}
              aria-label="Chat"
            >
              {chatId === null && <option value="">New chat</option>}
              {chats.data.map((c) => (
                <option key={c.chatId} value={c.chatId}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-sm" disabled={chatId === null} onClick={() => setSelected(null)}>
            <IconMessagePlus size={16} className="me-1" />
            New chat
          </button>
        </div>
      </div>
      <div className="card-body">
        {chats.data && (
          <BuilderChat
            chatId={chatId}
            pipelineId={pipelineId}
            placeholder='What to change, e.g. "Also skip LinkedIn notifications", or "Why did it skip the Acme email?"'
            onCreated={(id) => {
              setSelected(id);
              chats.reload();
            }}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}
