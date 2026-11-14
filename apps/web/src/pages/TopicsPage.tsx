import { type TopicLinkView, type TopicView } from "@realentity/storm-shared";
import { IconCheck, IconPlus } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { TopicSuggestions } from "../components/TopicSuggestions";
import { TopicRepliesCard, TopicTidyCard, TopicUpkeepCard } from "../components/TopicUpkeepCard";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime, formatUsd } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/** From this many topics, the list can be filtered. */
const FILTER_FROM = 8;

/**
 * Topics (M41-T2, docs/design.md §8.1): the subjects Storm keeps a memory of. This page lists them, with the pipelines
 * that keep them and what waits for the user; each topic's directions, facts, sources and emails are on its own page.
 */
export function TopicsPage() {
  const topics = useLoad(() => api.topics.list(), []);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const navigate = useNavigate();
  const words = filter.trim().toLowerCase();
  const shown = (topics.data ?? []).filter((t) => !words || `${t.name} ${t.description}`.toLowerCase().includes(words));
  return (
    <>
      <PageHeader
        title="Topics"
        pretitle="What Storm knows about a subject"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="topic-add">
            <IconPlus size={16} className="me-1" />
            New topic
          </button>
        }
      />
      <p className="text-secondary">
        A topic is a subject your email is about: a project, a customer, a house purchase. Its directions say which emails belong to it; an
        email can belong to none, one or several. Most email needs no topic. How it works: docs/topics.md.
      </p>
      <ErrorAlert error={topics.error} />
      <div className="row row-cards mb-3">
        <div className="col-lg-4">
          <TopicUpkeepCard />
        </div>
        <div className="col-lg-4">
          <TopicRepliesCard />
        </div>
        <div className="col-lg-4">
          <TopicTidyCard />
        </div>
      </div>
      <TopicSuggestions onAccepted={topics.reload} />
      {topics.data && topics.data.length > 0 && <Waiting topics={topics.data} onDecided={topics.reload} />}
      {adding && (
        <TopicForm
          topic={null}
          onDone={(saved) => {
            setAdding(false);
            if (saved) void navigate(`/topics/${saved.topicId}?tab=directions`);
          }}
        />
      )}
      {!topics.data && topics.loading && <Loading />}
      {topics.data?.length === 0 && !adding && <Empty>No topics yet. Make one for a subject you write a lot about.</Empty>}
      {topics.data && topics.data.length > 0 && (
        <div className="card" data-testid="topics-list">
          {topics.data.length >= FILTER_FROM && (
            <div className="card-body border-bottom py-2">
              <input
                className="form-control"
                placeholder="Find a topic"
                aria-label="Find a topic"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  <th>Topic</th>
                  <th className="text-end">Facts</th>
                  <th className="text-end">Sources</th>
                  <th className="text-end">Emails</th>
                  <th className="text-end">30 days</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((topic) => (
                  <TopicRow key={topic.topicId} topic={topic} />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-secondary">
                      No topic matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function TopicRow({ topic }: { topic: TopicView }) {
  const { counts } = topic;
  const archived = topic.status === "ARCHIVED";
  return (
    <tr className={archived ? "opacity-75" : ""} data-testid={`topic-row-${topic.name}`}>
      <td style={{ maxWidth: "32rem" }}>
        <Link to={`/topics/${topic.topicId}`} className="fw-bold">
          {topic.name}
        </Link>
        {archived && <span className="badge bg-secondary-lt ms-2">archived</span>}
        {topic.directions.length === 0 && !archived && (
          <span className="badge bg-yellow-lt ms-2" title="Without a direction, no email is linked to it">
            no directions
          </span>
        )}
        {topic.description && <div className="small text-secondary text-truncate">{topic.description}</div>}
      </td>
      <td className="text-end text-nowrap">
        {counts.facts}
        {counts.facts > counts.fit && (
          <span className="badge bg-orange-lt ms-2" title={`A draft has room for about ${counts.fit} of them`}>
            {counts.fit} fit
          </span>
        )}
        {counts.disputed > 0 && <span className="badge bg-red-lt ms-2">{counts.disputed} in dispute</span>}
      </td>
      <td className="text-end">{counts.sources}</td>
      <td className="text-end">{counts.emails}</td>
      <td className="text-end text-secondary">{topic.costUsd30 > 0 ? formatUsd(topic.costUsd30) : "–"}</td>
    </tr>
  );
}

/** A topic's name and description, new or edited. */
export function TopicForm({ topic, onDone }: { topic: TopicView | null; onDone: (saved: TopicView | null) => void }) {
  const [name, setName] = useState(topic?.name ?? "");
  const [description, setDescription] = useState(topic?.description ?? "");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await action.run(() =>
      topic ? api.topics.update(topic.topicId, { name, description }) : api.topics.create({ name, description }),
    );
    if (!saved) return;
    toast.success(`${saved.name} saved`);
    onDone(saved);
  };
  return (
    <form className="card mb-3" onSubmit={(e) => void submit(e)} data-testid="topic-form">
      <div className="card-body">
        <ErrorAlert error={action.error} title="Not saved" />
        <div className="mb-2">
          <label className="form-label required" htmlFor="topic-name">
            Name
          </label>
          <input
            id="topic-name"
            className="form-control"
            placeholder="Orion"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="mb-2">
          <label className="form-label" htmlFor="topic-description">
            What it is
          </label>
          <textarea
            id="topic-description"
            className="form-control"
            rows={3}
            placeholder="The customer portal rebuild for Client Ltd"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="form-hint">A few lines: Storm reads them to tell which email is about this.</div>
        </div>
      </div>
      <div className="card-footer d-flex gap-2 justify-content-end">
        <button type="button" className="btn" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={action.busy}>
          Save
        </button>
      </div>
    </form>
  );
}

const VIA = { DIRECTION: "by a direction", THREAD: "by its thread", LLM: "by Storm's LLM", USER: "by you" } as const;

/** An email of a link: subject, sender, date, and what shows it belongs. */
export function EmailLine({ link, topic }: { link: TopicLinkView; topic?: boolean }) {
  return (
    <div className="flex-fill overflow-hidden">
      <div className="fw-bold text-truncate">
        {link.subject || "(no subject)"}
        {topic && <span className="badge bg-azure-lt ms-2">{link.topicName}</span>}
      </div>
      <div className="small text-secondary">
        {link.from} · {formatDateTime(link.date)} · {VIA[link.via]}: {link.evidence}
      </div>
    </div>
  );
}

/** A link's decisions: move it to another topic (the one it is in left out). */
function MoveTo({
  link,
  topics,
  busy,
  onMove,
}: {
  link: TopicLinkView;
  topics: TopicView[];
  busy: boolean;
  onMove: (topicId: string) => void;
}) {
  const others = topics.filter((t) => t.topicId !== link.topicId && t.status === "ACTIVE");
  if (others.length === 0) return null;
  return (
    <select
      className="form-select form-select-sm w-auto"
      aria-label="Move to"
      value=""
      disabled={busy}
      onChange={(e) => e.target.value && onMove(e.target.value)}
    >
      <option value="">Move to…</option>
      {others.map((t) => (
        <option key={t.topicId} value={t.topicId}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

/** M41-T4: what only Storm's LLM thinks belongs to a topic, waiting for the user; each decision teaches the next check. */
function Waiting({ topics, onDecided }: { topics: TopicView[]; onDecided: () => void }) {
  const waiting = useLoad(() => api.topicLinks.waiting(), []);
  const action = useAction();
  const decide = async (work: () => Promise<TopicLinkView>) => {
    if (await action.run(work)) {
      waiting.reload();
      onDecided();
    }
  };
  if (!waiting.data?.length && !waiting.error) return null;
  return (
    <div className="card mb-3" data-testid="topics-waiting">
      <div className="card-header">
        <h3 className="card-title">Waiting for you</h3>
      </div>
      <div className="card-body pb-0">
        <p className="text-secondary small">Storm thinks these emails belong to a topic. Your answer teaches its next check.</p>
        <ErrorAlert error={waiting.error ?? action.error} />
      </div>
      <div className="list-group list-group-flush">
        {waiting.data?.map((link) => (
          <div key={link.topicLinkId} className="list-group-item d-flex align-items-center gap-2" data-testid={`waiting-${link.subject}`}>
            <EmailLine link={link} topic />
            <button
              type="button"
              className="btn btn-sm btn-success"
              disabled={action.busy}
              onClick={() => void decide(() => api.topicLinks.confirm(link.topicLinkId))}
            >
              <IconCheck size={16} className="me-1" />
              Yes
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={action.busy}
              onClick={() => void decide(() => api.topicLinks.reject(link.topicLinkId))}
            >
              No
            </button>
            <MoveTo
              link={link}
              topics={topics}
              busy={action.busy}
              onMove={(topicId) => void decide(() => api.topicLinks.move(link.topicLinkId, topicId))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
