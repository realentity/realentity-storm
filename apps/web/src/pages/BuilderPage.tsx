import { IconMessagePlus } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BuilderChat } from "../components/BuilderChat";
import { PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useLoad } from "../lib/use-load";

/**
 * A new pipeline from a description (docs/design.md §2.1): the builder asks what it needs and proposes a definition; saving
 * it creates the pipeline, whose page then holds the chat.
 */
export function BuilderPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const recent = useLoad(() => api.builder.list(), [chatId]);

  return (
    <>
      <PageHeader
        pretitle={<Link to="/pipelines">Pipelines</Link>}
        title="Describe a new pipeline"
        actions={
          chatId && (
            <Link to="/builder" className="btn">
              <IconMessagePlus size={18} className="me-1" />
              New chat
            </Link>
          )
        }
      />
      <div className="row g-3">
        <div className="col-xl-8">
          <div className="card">
            <div className="card-body">
              <BuilderChat
                chatId={chatId ?? null}
                placeholder='e.g. "Every weekday at 8, summarize new emails from my bank and send them to me on Telegram"'
                onCreated={(id) => void navigate(`/builder/${id}`, { replace: true })}
                onSaved={(chat) => chat.pipelineId && void navigate(`/pipelines/${chat.pipelineId}`)}
              />
            </div>
          </div>
        </div>
        <div className="col-xl-4">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Unsaved chats</h3>
            </div>
            <div className="list-group list-group-flush">
              {recent.data?.map((c) => (
                <Link
                  key={c.chatId}
                  to={`/builder/${c.chatId}`}
                  className={`list-group-item list-group-item-action ${c.chatId === chatId ? "active" : ""}`}
                >
                  <div>{c.title}</div>
                  <div className="small text-secondary">{formatDateTime(c.dateUpdated)}</div>
                </Link>
              ))}
              {recent.data?.length === 0 && <div className="list-group-item text-secondary">None.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
