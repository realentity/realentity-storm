import { type TopicDirectionKindName } from "./topics-api";

/** What of an email exact directions look at (M41-T3, docs/design.md §8.1). */
export interface MatchableEmail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
}

export interface MatchableDirection {
  kind: TopicDirectionKindName;
  value: string;
  about: string | null;
}

/**
 * How a topic's directions see an email, without an LLM: `exact` says it belongs (the first direction that matched, as
 * evidence); `hints` are for the LLM to judge (a person writing, when the direction is about something).
 */
export interface DirectionMatch {
  exact: string | null;
  hints: string[];
}

export function matchDirections(email: MatchableEmail, directions: MatchableDirection[]): DirectionMatch {
  const people = participants(email);
  const hints: string[] = [];
  for (const direction of directions) {
    switch (direction.kind) {
      case "WORD":
        if (hasWord(`${email.subject}\n${email.text}`, direction.value)) return { exact: `the word "${direction.value}"`, hints };
        break;
      case "DOMAIN": {
        const at = people.find((address) => inDomain(address, direction.value));
        if (at) return { exact: `${at}, at ${direction.value}`, hints };
        break;
      }
      case "PERSON":
        if (people.includes(direction.value)) {
          if (!direction.about) return { exact: `${direction.value} takes part`, hints };
          hints.push(`${direction.value} takes part: does it belong when it is about ${direction.about}?`);
        }
        break;
      case "TEXT":
        // Judged by the LLM from the topic's card.
        break;
    }
  }
  return { exact: null, hints };
}

/** Everyone on the email, lowercase. */
function participants(email: MatchableEmail): string[] {
  return [email.from, ...email.to, ...email.cc].map((a) => a.trim().toLowerCase()).filter(Boolean);
}

function inDomain(address: string, domain: string): boolean {
  const host = address.slice(address.lastIndexOf("@") + 1);
  return host === domain || host.endsWith(`.${domain}`);
}

/** The word or name as a whole (not inside another word), any case, any script. */
export function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}
