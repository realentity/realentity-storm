import { TOPIC_DIRECTION_KINDS, type TopicDirectionKindName, type TopicLinkView, type TopicView } from "@realentity/storm-shared";
import { IconArchive, IconArchiveOff, IconCheck, IconPencil, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { TopicFacts } from "../components/TopicFacts";
import { TopicSources } from "../components/TopicSources";
import { TopicUpkeepCard } from "../components/TopicUpkeepCard";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/** How each kind of direction reads, and what to type for it. */
const KIND: Record<TopicDirectionKindName, { label: string; placeholder: string; hint: string }> = {
  WORD: { label: "A word", placeholder: "Orion", hint: "In the subject or the text, as a whole word, any case." },
  DOMAIN: { label: "A domain", placeholder: "client.example", hint: "Anyone writing from it or its subdomains." },
  PERSON: { label: "A person", placeholder: "ivan@client.example", hint: "Their emails; with “about”, only those about that." },
  TEXT: {
    label: "In plain words",
    placeholder: "emails about the payment integration",
    hint: "Storm's LLM judges whether an email is about it.",
  },
};

/**
 * Topics (M41-T2, docs/design.md §8.1): the subjects Storm keeps a memory of, and the directions that say which email
 * belongs to one. Only the user writes them.
 */
export function TopicsPage() {
  const topics = useLoad(() => api.topics.list(), []);
  const [adding, setAdding] = useState(false);
  // A decision in the queue changes the topics' email lists.
  const [decided, setDecided] = useState(0);
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
        email can belong to none, one or several. Most email needs no topic.
      </p>
      <ErrorAlert error={topics.error} />
      <TopicUpkeepCard />
      {topics.data && topics.data.length > 0 && <Waiting topics={topics.data} onDecided={() => setDecided((n) => n + 1)} />}
      {adding && (
        <TopicForm
          topic={null}
          onDone={() => {
            setAdding(false);
            topics.reload();
          }}
        />
      )}
      {!topics.data && topics.loading && <Loading />}
      {topics.data?.length === 0 && !adding && <Empty>No topics yet. Make one for a subject you write a lot about.</Empty>}
      <div className="d-flex flex-column gap-3">
        {topics.data?.map((topic) => (
          <TopicCard key={topic.topicId} topic={topic} topics={topics.data ?? []} decided={decided} onChange={topics.reload} />
        ))}
      </div>
    </>
  );
}

function TopicCard({ topic, topics, decided, onChange }: { topic: TopicView; topics: TopicView[]; decided: number; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const archived = topic.status === "ARCHIVED";

  const setStatus = async () => {
    const saved = await action.run(() =>
      api.topics.update(topic.topicId, { name: topic.name, description: topic.description, status: archived ? "ACTIVE" : "ARCHIVED" }),
    );
    if (saved) onChange();
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${topic.name}, its directions and what it knows?`)) return;
    const done = await action.run(async () => {
      await api.topics.remove(topic.topicId);
      return true;
    });
    if (done) onChange();
  };
  const removeDirection = async (directionId: string) => {
    const saved = await action.run(() => api.topics.removeDirection(topic.topicId, directionId));
    if (saved) onChange();
  };

  if (editing)
    return (
      <TopicForm
        topic={topic}
        onDone={() => {
          setEditing(false);
          onChange();
        }}
      />
    );
  return (
    <div className={`card ${archived ? "opacity-75" : ""}`} data-testid={`topic-${topic.name}`}>
      <div className="card-header">
        <h3 className="card-title">
          {topic.name}
          {archived && <span className="badge bg-secondary-lt ms-2">archived</span>}
        </h3>
        <div className="card-actions d-flex gap-1">
          <button type="button" className="btn btn-sm btn-ghost-secondary" aria-label="Edit" onClick={() => setEditing(true)}>
            <IconPencil size={16} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost-secondary"
            aria-label={archived ? "Reactivate" : "Archive"}
            title={archived ? "Reactivate: match new email again" : "Archive: match no new email, keep what it knows"}
            disabled={action.busy}
            onClick={() => void setStatus()}
          >
            {archived ? <IconArchiveOff size={16} /> : <IconArchive size={16} />}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost-danger"
            aria-label="Delete"
            disabled={action.busy}
            onClick={() => void remove()}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} />
        {topic.description ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{topic.description}</p>
        ) : (
          <p className="text-secondary">No description.</p>
        )}
        <h4 className="mb-2">Directions</h4>
        {topic.directions.length === 0 && <p className="text-secondary small">None yet: without a direction, no email is linked to it.</p>}
        {topic.directions.length > 0 && (
          <div className="list-group mb-3" data-testid="directions">
            {topic.directions.map((d) => (
              <div key={d.topicDirectionId} className="list-group-item d-flex align-items-center gap-2 py-2">
                <span className="badge bg-azure-lt">{KIND[d.kind].label}</span>
                <span className="flex-fill">
                  {d.kind === "TEXT" ? d.value : <code>{d.value}</code>}
                  {d.about && <span className="text-secondary"> about {d.about}</span>}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost-danger"
                  aria-label="Remove direction"
                  disabled={action.busy}
                  onClick={() => void removeDirection(d.topicDirectionId)}
                >
                  <IconX size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <DirectionForm topicId={topic.topicId} onAdded={onChange} />
        <TopicFacts topic={topic} topics={topics} />
        <TopicSources topicId={topic.topicId} />
        <TopicEmails topicId={topic.topicId} decided={decided} />
      </div>
    </div>
  );
}

function DirectionForm({ topicId, onAdded }: { topicId: string; onAdded: () => void }) {
  const [kind, setKind] = useState<TopicDirectionKindName>("WORD");
  const [value, setValue] = useState("");
  const [about, setAbout] = useState("");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await action.run(() =>
      api.topics.addDirection(topicId, { kind, value, about: kind === "PERSON" && about.trim() ? about : null }),
    );
    if (!saved) return;
    setValue("");
    setAbout("");
    onAdded();
  };
  return (
    <form onSubmit={(e) => void submit(e)} data-testid="direction-form">
      <ErrorAlert error={action.error} title="Not added" />
      <div className="row g-2">
        <div className="col-sm-3">
          <select
            className="form-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as TopicDirectionKindName)}
            aria-label="Kind"
          >
            {TOPIC_DIRECTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND[k].label}
              </option>
            ))}
          </select>
        </div>
        <div className={kind === "PERSON" ? "col-sm-4" : "col-sm-7"}>
          <input
            className="form-control"
            value={value}
            placeholder={KIND[kind].placeholder}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Direction"
            required
          />
        </div>
        {kind === "PERSON" && (
          <div className="col-sm-3">
            <input
              className="form-control"
              value={about}
              placeholder="about (optional): the API"
              onChange={(e) => setAbout(e.target.value)}
              aria-label="About"
            />
          </div>
        )}
        <div className="col-sm-2">
          <button type="submit" className="btn w-100" disabled={action.busy || !value.trim()}>
            Add
          </button>
        </div>
      </div>
      <div className="form-hint">{KIND[kind].hint}</div>
    </form>
  );
}

function TopicForm({ topic, onDone }: { topic: TopicView | null; onDone: () => void }) {
  const [name, setName] = useState(topic?.name ?? "");
  const [description, setDescription] = useState(topic?.description ?? "");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await action.run(() =>
      topic ? api.topics.update(topic.topicId, { name, description, status: topic.status }) : api.topics.create({ name, description }),
    );
    if (!saved) return;
    toast.success(`${saved.name} saved`);
    onDone();
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

const VIA = { DIRECTION: "by a direction", THREAD: "by its thread", LLM: "by Storm's LLM", USER: "by you" } as const;

/** An email of a link: subject, sender, date, and what shows it belongs. */
function EmailLine({ link, topic }: { link: TopicLinkView; topic?: boolean }) {
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

/** A topic's emails (M41-T4), newest first: one taken out says it doesn't belong. */
function TopicEmails({ topicId, decided }: { topicId: string; decided: number }) {
  const links = useLoad(() => api.topics.links(topicId), [topicId, decided]);
  const action = useAction();
  const reject = async (link: TopicLinkView) => {
    if (await action.run(() => api.topicLinks.reject(link.topicLinkId))) links.reload();
  };
  const linked = links.data?.filter((l) => l.status !== "SUGGESTED") ?? [];
  return (
    <div className="mt-3" data-testid="topic-emails">
      <h4 className="mb-2">Emails</h4>
      <ErrorAlert error={links.error ?? action.error} />
      {links.data && linked.length === 0 && (
        <p className="text-secondary small">No email linked yet: the pipelines with topic.match link them.</p>
      )}
      {linked.length > 0 && (
        <div className="list-group">
          {linked.map((link) => (
            <div key={link.topicLinkId} className="list-group-item d-flex align-items-center gap-2 py-2">
              <EmailLine link={link} />
              {link.status === "CONFIRMED" && <span className="badge bg-green-lt">confirmed</span>}
              <button
                type="button"
                className="btn btn-sm btn-ghost-secondary"
                title="Not this topic"
                aria-label="Not this topic"
                disabled={action.busy}
                onClick={() => void reject(link)}
              >
                <IconX size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
