import { z } from "zod";
import { type PipelineSuggestionView } from "./learning-api";
import { type CompiledDefinition, type CompiledPolicy, type CompileIssue } from "./pipeline";
import { type DefinitionDiff } from "./pipeline-api";
import { type RunDetailView } from "./runs-api";

/** A chat about one pipeline (README §2.5), or without one to describe a new pipeline (README §2.1). */
export const CreateBuilderChatSchema = z
  .object({
    pipelineId: z.uuid().optional(),
    /** M34: a chat about an App: changing it (and its pipelines) from a sentence. */
    appId: z.uuid().optional(),
  })
  .strict()
  .refine((c) => !(c.pipelineId && c.appId), "a chat is about a pipeline or an App, not both");
export type CreateBuilderChatRequest = z.infer<typeof CreateBuilderChatSchema>;

export const BuilderChatFilterSchema = z.object({ pipelineId: z.uuid().optional() }).strict();
export type BuilderChatFilter = z.infer<typeof BuilderChatFilterSchema>;

export const BuilderMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
    /** A reflection suggestion to turn into a diff (README §2.5); saving the result marks it done. */
    suggestionId: z.uuid().optional(),
  })
  .strict();
export type BuilderMessageRequest = z.infer<typeof BuilderMessageSchema>;

/** open: can be saved; saved: became a version; superseded: a later proposal in the chat replaced it. */
export type BuilderProposalStatus = "open" | "saved" | "superseded";

/** A definition the builder proposed. It compiled when proposed; saving compiles it again. */
export interface BuilderProposalView {
  status: BuilderProposalStatus;
  /** One line from the builder: what it does or what changed. */
  summary: string;
  /** As authored (YAML), for the editor; gates the compiler inserts are not in it. */
  source: string;
  definition: CompiledDefinition;
  policy: CompiledPolicy;
  warnings: CompileIssue[];
  /** Against the pipeline's current version as it is now; null for a new pipeline. */
  diff: DefinitionDiff | null;
  savedVersion: number | null;
}

/**
 * M34: an App the builder proposed with its pipelines, saved together or not at all. Each compiled against the App
 * when proposed, and again when saved; the App's other pipelines too.
 */
export interface AppProposalView {
  status: BuilderProposalStatus;
  summary: string;
  app: { name: string; source: string; isNew: boolean; changes: string[] };
  pipelines: { name: string; source: string; isNew: boolean; changes: string[] }[];
  /** Once saved: the App's id. */
  savedAppId: string | null;
}

export interface BuilderMessageView {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  proposal: BuilderProposalView | null;
  /** M34: an App and its pipelines proposed together. */
  appProposal: AppProposalView | null;
  /** The builder's last attempt didn't compile (M7-U1): what the compiler said. */
  compileErrors: CompileIssue[] | null;
  /** The turn failed (API error, token cap, refusal). */
  error: string | null;
  costUsd: number | null;
  dateCreated: string;
}

export interface BuilderChatSummaryView {
  chatId: string;
  pipelineId: string | null;
  /** M34: the App this chat changes. */
  appId: string | null;
  /** The first message, shortened. */
  title: string;
  model: string;
  dateCreated: string;
  dateUpdated: string;
}

export interface BuilderChatView extends BuilderChatSummaryView {
  pipelineName: string | null;
  /** The pipeline's saved version the proposals are compared with; null: none yet (saving makes v1). */
  currentVersion: number | null;
  /** Tokens this chat's calls used, against its cap (BUILDER_CHAT_MAX_TOKENS). */
  tokensUsed: number;
  tokenCap: number;
  costUsd: number;
  messages: BuilderMessageView[];
  /** Open reflection suggestions for the pipeline (README §2.5). */
  suggestions: PipelineSuggestionView[];
  /** ANTHROPIC_API_KEY is set. */
  available: boolean;
}

export interface BuilderDryRunResponse {
  chat: BuilderChatView;
  run: RunDetailView;
}
