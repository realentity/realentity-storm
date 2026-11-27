import { z } from "zod";
import { type PipelineSuggestionView } from "./learning-api";
import { type CompiledDefinition, type CompiledPolicy, type CompileIssue } from "./pipeline";
import { type DefinitionDiff } from "./pipeline-api";
import { type RunDetailView } from "./runs-api";

/** A chat about one pipeline (docs/design.md §2.5), or without one to describe a new pipeline (docs/design.md §2.1). */
export const CreateBuilderChatSchema = z
  .object({
    pipelineId: z.uuid().optional(),
    /** M34: a chat about an App: changing it (and its pipelines) from a sentence. */
    appId: z.uuid().optional(),
  })
  .strict()
  .refine((c) => !(c.pipelineId && c.appId), "a chat is about a pipeline or an App, not both");
export type CreateBuilderChatRequest = z.infer<typeof CreateBuilderChatSchema>;

export const BuilderChatFilterSchema = z.object({ pipelineId: z.uuid().optional(), appId: z.uuid().optional() }).strict();
export type BuilderChatFilter = z.infer<typeof BuilderChatFilterSchema>;

export const BuilderMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
    /** A reflection suggestion to turn into a diff (docs/design.md §2.5); saving the result marks it done. */
    suggestionId: z.uuid().optional(),
    /**
     * M38-T5: sent from an editor: what it has open (not saved yet) and what the user is on there ("step fetch, input
     * sinceDays"). The builder changes the draft, not the saved version.
     */
    editor: z
      .object({ source: z.string().max(200_000), focus: z.string().max(300).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type BuilderMessageRequest = z.infer<typeof BuilderMessageSchema>;

/**
 * M70-T2: what the builder says it will make, before it proposes a new idea: the App with its types and the fields that
 * matter, each pipeline (what starts it, what it does, what waits for me, what it sends), what I set up after, and what
 * Storm can't do of what I asked. I agree or change it; then it proposes. It stays in the chat as what was agreed.
 */
export const BuilderBriefSchema = z
  .object({
    summary: z.string().trim().min(1).max(500).describe("One or two sentences: what it is for."),
    app: z
      .object({
        name: z.string().trim().min(1).max(60),
        types: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(40),
                about: z.string().trim().min(1).max(300).describe("What one is, what identifies it, its stages if it has any."),
                fields: z.array(z.string().trim().min(1).max(120)).max(30).describe("The fields that matter, in words: which ones I type."),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .optional()
      .describe("Left out for a pipeline without an App."),
    pipelines: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            trigger: z.string().trim().min(1).max(200).describe("What starts it, in words: every day at 7:00, when a Bill is saved, a button."),
            does: z.string().trim().min(1).max(600).describe("What it reads and does, in order."),
            waitsForMe: z.string().trim().max(300).optional().describe("What waits for my approval before it happens."),
            sends: z.string().trim().max(300).optional().describe("What it sends or changes outside, and to whom (where the address comes from)."),
          })
          .strict(),
      )
      .max(10),
    setup: z.array(z.string().trim().min(1).max(200)).max(10).default([]).describe("What I set up after saving: an account, a credential, a setting."),
    cannot: z.array(z.string().trim().min(1).max(300)).max(10).default([]).describe("What of what I asked Storm can't do, said plainly."),
  })
  .strict();
export type BuilderBrief = z.output<typeof BuilderBriefSchema>;

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
  /** M70-T2: what it said it will make, before proposing a new idea. */
  brief: BuilderBrief | null;
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
  /** Tokens this chat's calls used, against its cap (Settings → AI, else BUILDER_CHAT_MAX_TOKENS). */
  tokensUsed: number;
  tokenCap: number;
  costUsd: number;
  messages: BuilderMessageView[];
  /** Open reflection suggestions for the pipeline (docs/design.md §2.5). */
  suggestions: PipelineSuggestionView[];
  /** A model is set up: Claude or a model server, on, in Settings → AI (M62). */
  available: boolean;
}

export interface BuilderDryRunResponse {
  chat: BuilderChatView;
  run: RunDetailView;
}
