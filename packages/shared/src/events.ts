import { type ProposalStatusName, type RunStatusName, type StepStatusName } from "./runs-api";

/** The WebSocket the web app listens on (same origin, session cookie). */
export const EVENTS_PATH = "/api/events";

/**
 * Something changed; the web app refetches what it shows. Events carry ids and statuses only, never payloads, so
 * nothing sensitive goes over the socket and a missed event costs at most a stale screen until the next one.
 */
export type AppEvent =
  | { type: "run"; runId: string; pipelineId: string; status: RunStatusName }
  | { type: "step"; runId: string; stepKey: string; itemIndex: number | null; status: StepStatusName }
  | { type: "proposal"; proposalId: string; runId: string; status: ProposalStatusName }
  | { type: "killSwitch"; engaged: boolean }
  /** Rules, pipeline suggestions or a reflection changed (the Rules page). */
  | { type: "learning" };
