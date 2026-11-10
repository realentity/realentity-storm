import { type TopicView } from "@realentity/storm-shared";
import { useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

type Picks = Record<"facts" | "directions" | "sources" | "links", Set<string>>;

/**
 * Split (M44-T4, docs/design.md §8.1): name the new topic, tick what goes there (its facts, directions, sources,
 * emails). One change on both topics' history: Undo brings everything back.
 */
export function SplitForm({ topic, onDone }: { topic: TopicView; onDone: (split: boolean) => void }) {
  const facts = useLoad(() => api.topics.facts(topic.topicId), [topic.topicId]);
  const sources = useLoad(() => api.topics.sources(topic.topicId), [topic.topicId]);
  const links = useLoad(() => api.topics.links(topic.topicId), [topic.topicId]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picks, setPicks] = useState<Picks>({ facts: new Set(), directions: new Set(), sources: new Set(), links: new Set() });
  const action = useAction();
  const toggle = (group: keyof Picks, id: string) =>
    setPicks((all) => {
      const next = new Set(all[group]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...all, [group]: next };
    });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const done = await action.run(() =>
      api.topics.split(topic.topicId, {
        name,
        description,
        facts: [...picks.facts],
        directions: [...picks.directions],
        sources: [...picks.sources],
        links: [...picks.links],
      }),
    );
    if (!done) return;
    toast.success(`${name} made from ${topic.name}`);
    onDone(true);
  };
  const group = (title: string, key: keyof Picks, items: { id: string; label: string }[]) =>
    items.length > 0 && (
      <div className="mb-2">
        <div className="fw-bold small mb-1">{title}</div>
        {items.map((item) => (
          <label key={item.id} className="form-check mb-1">
            <input type="checkbox" className="form-check-input" checked={picks[key].has(item.id)} onChange={() => toggle(key, item.id)} />
            <span className="form-check-label small">{item.label}</span>
          </label>
        ))}
      </div>
    );
  return (
    <form className="card card-body mb-3" onSubmit={(e) => void submit(e)} data-testid="split-form">
      <ErrorAlert error={action.error ?? facts.error ?? sources.error ?? links.error} title="Not split" />
      <div className="row g-2 mb-2">
        <div className="col-sm-4">
          <input
            className="form-control"
            placeholder="The new topic's name"
            aria-label="New topic"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="col-sm-8">
          <input
            className="form-control"
            placeholder="What it is"
            aria-label="What it is"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <p className="text-secondary small">Tick what goes to it. One change on both topics: Undo brings it all back.</p>
      {group(
        "Facts",
        "facts",
        (facts.data ?? [])
          .filter((f) => f.status !== "SUPERSEDED")
          .map((f) => ({ id: f.topicFactId, label: `${f.about}: ${f.statement}` })),
      )}
      {group(
        "Directions",
        "directions",
        topic.directions.map((d) => ({ id: d.topicDirectionId, label: `${d.value}${d.about ? ` about ${d.about}` : ""}` })),
      )}
      {group(
        "Sources",
        "sources",
        (sources.data ?? []).map((s) => ({
          id: s.topicSourceId,
          label: s.kind === "ATTACHMENT" ? `${s.path} (${s.title})` : `${s.location} ${s.path}`,
        })),
      )}
      {group(
        "Emails",
        "links",
        (links.data ?? [])
          .filter((l) => l.status !== "SUGGESTED")
          .map((l) => ({ id: l.topicLinkId, label: `${l.subject || "(no subject)"} · ${l.from}` })),
      )}
      <div className="d-flex gap-2 justify-content-end">
        <button type="button" className="btn" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={action.busy || !name.trim()}>
          Split
        </button>
      </div>
    </form>
  );
}

/** Merge (M44-T4): this topic into another; the facts they disagree on are put in dispute; this one is archived. */
export function MergeInto({ topic, topics, onMerged }: { topic: TopicView; topics: TopicView[]; onMerged: () => void }) {
  const action = useAction();
  const others = topics.filter((t) => t.topicId !== topic.topicId && t.status === "ACTIVE");
  if (others.length === 0) return null;
  const merge = async (into: TopicView) => {
    if (
      !window.confirm(
        `Merge ${topic.name} into ${into.name}? Facts they disagree on are put in dispute; ${topic.name} is archived. Undo brings it back.`,
      )
    )
      return;
    const done = await action.run(() => api.topics.merge(topic.topicId, { into: into.topicId }));
    if (!done) {
      toast.error("Not merged");
      return;
    }
    toast.success(`${topic.name} merged into ${into.name}${done.disputed ? `: ${done.disputed} in dispute` : ""}`);
    onMerged();
  };
  return (
    <select
      className="form-select form-select-sm w-auto"
      aria-label="Merge into"
      value=""
      disabled={action.busy}
      onChange={(e) => {
        const into = others.find((t) => t.topicId === e.target.value);
        if (into) void merge(into);
      }}
    >
      <option value="">Merge into…</option>
      {others.map((t) => (
        <option key={t.topicId} value={t.topicId}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
