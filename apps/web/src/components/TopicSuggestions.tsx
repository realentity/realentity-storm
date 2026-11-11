import { type TopicSuggestionView } from "@realentity/storm-shared";
import { IconBulb, IconCheck } from "@tabler/icons-react";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

const KIND = { PERSON: "the person", DOMAIN: "everyone at", WORD: "the word", TEXT: "emails about" } as const;

/** One line for a suggestion: what accepting it does. */
function what(s: TopicSuggestionView): string {
  if (s.kind === "DIRECTION") {
    const d = s.payload as { kind: keyof typeof KIND; value: string; about: string | null };
    return `${s.topicName ?? ""}: add ${KIND[d.kind] ?? d.kind} ${d.value}${d.about ? ` about ${d.about}` : ""} as a direction?`;
  }
  if (s.kind === "TOPIC") {
    const t = s.payload as { name: string; description: string };
    return `A new topic: ${t.name}${t.description ? `, ${t.description}` : ""}?`;
  }
  return `${String((s.payload as { title?: string }).title ?? "")}?`;
}

/**
 * What Storm suggests for topics (M44, docs/design.md §8.1): directions from the user's own decisions, new topics, facts
 * from their edits. Nothing is active before Yes; No isn't asked again.
 */
export function TopicSuggestions({ onAccepted }: { onAccepted: () => void }) {
  const suggestions = useLoad(() => api.topicSuggestions.open(), []);
  const action = useAction();
  const decide = async (work: () => Promise<TopicSuggestionView>, accepted: boolean) => {
    if (await action.run(work)) {
      suggestions.reload();
      if (accepted) onAccepted();
    }
  };
  if (!suggestions.data?.length && !suggestions.error) return null;
  return (
    <div className="card mb-3" data-testid="topic-suggestions">
      <div className="card-header">
        <h3 className="card-title">
          <IconBulb size={18} className="me-1" />
          Suggested
        </h3>
      </div>
      <div className="card-body pb-0">
        <p className="text-secondary small">From your own decisions. Nothing changes until you say yes; a no isn't asked again.</p>
        <ErrorAlert error={suggestions.error ?? action.error} />
      </div>
      <div className="list-group list-group-flush">
        {suggestions.data?.map((s) => (
          <div key={s.topicSuggestionId} className="list-group-item d-flex align-items-center gap-2" data-testid={`suggestion-${s.kind}`}>
            <div className="flex-fill overflow-hidden">
              <div className="text-truncate">{what(s)}</div>
              <div className="small text-secondary">{s.reason}</div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-success"
              disabled={action.busy}
              onClick={() => void decide(() => api.topicSuggestions.accept(s.topicSuggestionId), true)}
            >
              <IconCheck size={16} className="me-1" />
              Yes
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={action.busy}
              onClick={() => void decide(() => api.topicSuggestions.dismiss(s.topicSuggestionId), false)}
            >
              No
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
