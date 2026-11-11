import { TOPIC_DIRECTION_KINDS, type TopicDirectionKindName, type TopicLinkView, type TopicView } from "@realentity/storm-shared";
import { IconArchive, IconArchiveOff, IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { TopicFacts } from "../components/TopicFacts";
import { TopicHistory } from "../components/TopicHistory";
import { TopicSources } from "../components/TopicSources";
import { MergeInto, SplitForm } from "../components/TopicSplitMerge";
import { ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatUsd } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { EmailLine, TopicForm } from "./TopicsPage";

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

const TABS = ["directions", "facts", "sources", "emails"] as const;
type Tab = (typeof TABS)[number];

/**
 * A topic's own page (M41–M44, docs/design.md §8.1): its description, and one tab at a time of its directions, facts
 * (with the reading of its history), sources and emails, so a topic that knows a lot stays readable.
 */
export function TopicPage() {
  const { topicId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const topics = useLoad(() => api.topics.list(), [topicId]);
  const [editing, setEditing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  // The facts list is remounted when its history adds facts.
  const [kept, setKept] = useState(0);
  const action = useAction();

  const topic = topics.data?.find((t) => t.topicId === topicId);
  if (!topics.data) return topics.error ? <ErrorAlert error={topics.error} /> : <Loading />;
  if (!topic)
    return (
      <>
        <PageHeader title="No such topic" pretitle={<Link to="/topics">Topics</Link>} />
        <p className="text-secondary">
          It was deleted, or never was. <Link to="/topics">All topics</Link>
        </p>
      </>
    );

  const asked = search.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : topic.directions.length ? "facts" : "directions";
  const archived = topic.status === "ARCHIVED";
  const { counts } = topic;

  const setStatus = async () => {
    const saved = await action.run(() =>
      api.topics.update(topic.topicId, { name: topic.name, description: topic.description, status: archived ? "ACTIVE" : "ARCHIVED" }),
    );
    if (saved) topics.reload();
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${topic.name}, its directions and what it knows?`)) return;
    if (await action.run(async () => (await api.topics.remove(topic.topicId), true))) void navigate("/topics");
  };

  const label: Record<Tab, string> = {
    directions: `Directions (${topic.directions.length})`,
    facts: `Facts (${counts.facts})`,
    sources: `Sources (${counts.sources})`,
    emails: `Emails (${counts.emails})`,
  };
  return (
    <div data-testid={`topic-${topic.name}`}>
      <PageHeader
        pretitle={<Link to="/topics">Topics</Link>}
        title={
          <>
            {topic.name}
            {archived && <span className="badge bg-secondary-lt ms-2">archived</span>}
            {topic.costUsd30 > 0 && (
              <span className="badge bg-azure-lt ms-2" title="Its upkeep and history reads, the last 30 days" data-testid="topic-cost">
                {formatUsd(topic.costUsd30)} in 30 days
              </span>
            )}
          </>
        }
        actions={
          <>
            <MergeInto topic={topic} topics={topics.data} onMerged={topics.reload} />
            <button type="button" className="btn btn-sm" title="Split: part of it becomes a new topic" onClick={() => setSplitting(true)}>
              Split
            </button>
            <button type="button" className="btn btn-sm" aria-label="Edit" onClick={() => setEditing(true)}>
              <IconPencil size={16} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={archived ? "Reactivate" : "Archive"}
              title={archived ? "Reactivate: match new email again" : "Archive: match no new email, keep what it knows"}
              disabled={action.busy}
              onClick={() => void setStatus()}
            >
              {archived ? <IconArchiveOff size={16} /> : <IconArchive size={16} />}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              aria-label="Delete"
              disabled={action.busy}
              onClick={() => void remove()}
            >
              <IconTrash size={16} />
            </button>
          </>
        }
      />
      <ErrorAlert error={action.error} />
      {splitting && (
        <SplitForm
          topic={topic}
          onDone={(made) => {
            setSplitting(false);
            if (made) void navigate(`/topics/${made}?tab=facts`);
          }}
        />
      )}
      {editing ? (
        <TopicForm
          topic={topic}
          onDone={() => {
            setEditing(false);
            topics.reload();
          }}
        />
      ) : (
        <div className="card mb-3">
          <div className="card-body">
            {topic.description ? (
              <p className="mb-2" style={{ whiteSpace: "pre-wrap" }}>
                {topic.description}
              </p>
            ) : (
              <p className="text-secondary mb-2">No description.</p>
            )}
            <div className="small text-secondary" data-testid="topic-summary">
              {summary(topic)}
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-header">
          <ul className="nav nav-tabs card-header-tabs" role="tablist">
            {TABS.map((t) => (
              <li key={t} className="nav-item">
                <button
                  type="button"
                  role="tab"
                  aria-selected={t === tab}
                  className={`nav-link ${t === tab ? "active" : ""}`}
                  data-testid={`tab-${t}`}
                  onClick={() => setSearch({ tab: t }, { replace: true })}
                >
                  {label[t]}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card-body">
          {tab === "directions" && <Directions topic={topic} onChange={topics.reload} />}
          {tab === "facts" && (
            <>
              <TopicFacts key={kept} topic={topic} topics={topics.data} />
              <TopicHistory
                topicId={topic.topicId}
                onApplied={() => {
                  setKept((n) => n + 1);
                  topics.reload();
                }}
              />
            </>
          )}
          {tab === "sources" && <TopicSources topicId={topic.topicId} />}
          {tab === "emails" && <TopicEmails topicId={topic.topicId} onChange={topics.reload} />}
        </div>
      </div>
    </div>
  );
}

/** "12 facts (a draft has room for about 10) · 2 in dispute · 3 sources · 40 emails". */
function summary(topic: TopicView): string {
  const { counts } = topic;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [
    plural(counts.facts, "fact") + (counts.facts > counts.fit ? ` (a draft has room for about ${counts.fit})` : ""),
    ...(counts.disputed ? [`${counts.disputed} in dispute`] : []),
    plural(counts.sources, "source"),
    plural(counts.emails, "email"),
  ].join(" · ");
}

function Directions({ topic, onChange }: { topic: TopicView; onChange: () => void }) {
  const action = useAction();
  const remove = async (directionId: string, text: string) => {
    if (!window.confirm(`Remove the direction ${text}? Emails it linked stay linked; new ones are no longer matched by it.`)) return;
    if (await action.run(() => api.topics.removeDirection(topic.topicId, directionId))) onChange();
  };
  return (
    <>
      <ErrorAlert error={action.error} />
      <p className="text-secondary small">Directions say which email belongs to the topic: an email can belong to none, one or several.</p>
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
                onClick={() => void remove(d.topicDirectionId, d.value)}
              >
                <IconX size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <DirectionForm topicId={topic.topicId} onAdded={onChange} />
    </>
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

/** A topic's emails (M41-T4), newest first: one taken out says it doesn't belong. */
function TopicEmails({ topicId, onChange }: { topicId: string; onChange: () => void }) {
  const links = useLoad(() => api.topics.links(topicId), [topicId]);
  const action = useAction();
  const reject = async (link: TopicLinkView) => {
    if (!window.confirm(`Take "${link.subject || "(no subject)"}" out of the topic? Storm learns it doesn't belong.`)) return;
    if (await action.run(() => api.topicLinks.reject(link.topicLinkId))) {
      links.reload();
      onChange();
    }
  };
  const linked = links.data?.filter((l) => l.status !== "SUGGESTED") ?? [];
  return (
    <div data-testid="topic-emails">
      <ErrorAlert error={links.error ?? action.error} />
      {links.data && linked.length === 0 && (
        <p className="text-secondary small mb-0">No email linked yet: the pipelines with topic.match link them.</p>
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
