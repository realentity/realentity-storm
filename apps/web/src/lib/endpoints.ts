import {
  type ApproveProposalRequest,
  type BuilderChatSummaryView,
  type BuilderChatView,
  type BuilderDryRunResponse,
  type CompilePipelineResponse,
  type CreateCredentialRequest,
  type CreateRuleRequest,
  type CredentialView,
  type DocumentView,
  type DryRunPipelineResponse,
  type GoogleStatusView,
  type ImportRecipeRequest,
  type JobFilter,
  type JobPostingView,
  type JobStatusName,
  type KillSwitchView,
  type LearningView,
  type LiveView,
  type TakeoverView,
  type LoginRequest,
  type PipelineDetailView,
  type PipelineSummaryView,
  type PipelineVersionView,
  type ProposalStatusName,
  type ProposalView,
  type RecipeDetailView,
  type RecipeSummaryView,
  type RunDetailView,
  type RunFilter,
  type RuleView,
  type RunSummaryView,
  type ScheduledStartView,
  type SessionView,
  type SettingsRequest,
  type SettingsView,
  type StepTypeView,
  type SuggestionStatusName,
  type TeachRecipeRequest,
  type TeachStartedView,
  type UpdatePipelineRequest,
  type WebhookView,
  type UpdateRuleRequest,
} from "@ai-me/shared";
import { query, request } from "./api";

/** Every api route the web app uses, typed with the shared DTOs. */
export const api = {
  auth: {
    session: () => request<SessionView>("GET", "/auth/session"),
    login: (body: LoginRequest) => request<SessionView>("POST", "/auth/login", body),
    logout: () => request<void>("POST", "/auth/logout"),
  },
  steps: {
    list: () => request<StepTypeView[]>("GET", "/steps"),
  },
  pipelines: {
    list: () => request<PipelineSummaryView[]>("GET", "/pipelines"),
    get: (pipelineId: string) => request<PipelineDetailView>("GET", `/pipelines/${pipelineId}`),
    version: (pipelineId: string, version: number) => request<PipelineVersionView>("GET", `/pipelines/${pipelineId}/versions/${version}`),
    compile: (source: string, pipelineId?: string) =>
      request<CompilePipelineResponse>("POST", "/pipelines/compile", { source, pipelineId }),
    dryRun: (source: string, pipelineId?: string) => request<DryRunPipelineResponse>("POST", "/pipelines/dry-run", { source, pipelineId }),
    create: (source: string) => request<PipelineDetailView>("POST", "/pipelines", { source }),
    addVersion: (pipelineId: string, source: string) =>
      request<PipelineDetailView>("POST", `/pipelines/${pipelineId}/versions`, { source }),
    discardDraft: (pipelineId: string) => request<void>("DELETE", `/pipelines/${pipelineId}/draft`),
    update: (pipelineId: string, body: UpdatePipelineRequest) => request<PipelineDetailView>("PATCH", `/pipelines/${pipelineId}`, body),
    run: (pipelineId: string, dryRun: boolean) => request<RunDetailView>("POST", `/pipelines/${pipelineId}/runs`, { dryRun }),
    webhook: (pipelineId: string) => request<{ webhook: WebhookView | null }>("GET", `/pipelines/${pipelineId}/webhook`),
    rotateWebhook: (pipelineId: string) => request<WebhookView>("PUT", `/pipelines/${pipelineId}/webhook`),
    removeWebhook: (pipelineId: string) => request<void>("DELETE", `/pipelines/${pipelineId}/webhook`),
  },
  runs: {
    list: (filter: Partial<RunFilter> = {}) => request<RunSummaryView[]>("GET", `/runs${query(filter)}`),
    get: (runId: string) => request<RunDetailView>("GET", `/runs/${runId}`),
    live: (runId: string) => request<LiveView>("GET", `/runs/${runId}/live`),
    takeOver: (runId: string) => request<void>("POST", `/runs/${runId}/takeover`),
    continue: (runId: string) => request<void>("POST", `/runs/${runId}/continue`),
    abort: (runId: string) => request<void>("POST", `/runs/${runId}/abort`),
  },
  /** Runs waiting for me in the live view. */
  takeovers: () => request<(TakeoverView & { runId: string; pipelineName: string })[]>("GET", "/takeovers"),
  /** A run's file (screenshot, trace, download): an address for <img> or a download link. */
  artifactUrl: (artifactId: string) => `/api/artifacts/${artifactId}`,
  proposals: {
    list: (status: ProposalStatusName = "PENDING_REVIEW") => request<ProposalView[]>("GET", `/proposals${query({ status })}`),
    get: (proposalId: string) => request<ProposalView>("GET", `/proposals/${proposalId}`),
    approve: (proposalId: string, body: Partial<ApproveProposalRequest>) =>
      request<ProposalView>("POST", `/proposals/${proposalId}/approve`, body),
    reject: (proposalId: string, reason?: string) => request<ProposalView>("POST", `/proposals/${proposalId}/reject`, { reason }),
  },
  credentials: {
    list: () => request<CredentialView[]>("GET", "/credentials"),
    create: (body: CreateCredentialRequest) => request<CredentialView>("POST", "/credentials", body),
    replaceSecret: (credentialId: string, secret: string) =>
      request<CredentialView>("PUT", `/credentials/${credentialId}/secret`, { secret }),
    remove: (credentialId: string) => request<void>("DELETE", `/credentials/${credentialId}`),
  },
  killSwitch: {
    get: () => request<KillSwitchView>("GET", "/kill-switch"),
    set: (engaged: boolean) => request<KillSwitchView>("PUT", "/kill-switch", { engaged }),
  },
  google: {
    status: () => request<GoogleStatusView>("GET", "/google"),
    connect: (returnTo?: string) => request<{ url: string }>("POST", "/google/connect", returnTo ? { returnTo } : {}),
    disconnect: () => request<void>("DELETE", "/google"),
  },
  scheduledStarts: {
    list: (pipelineId?: string) => request<ScheduledStartView[]>("GET", `/scheduled-starts${pipelineId ? `?pipelineId=${pipelineId}` : ""}`),
    cancel: (id: string) => request<void>("DELETE", `/scheduled-starts/${id}`),
  },
  settings: {
    get: () => request<SettingsView>("GET", "/settings"),
    update: (body: SettingsRequest) => request<SettingsView>("PUT", "/settings", body),
  },
  learning: {
    get: () => request<LearningView>("GET", "/learning"),
    createRule: (body: CreateRuleRequest) => request<RuleView>("POST", "/rules", body),
    updateRule: (ruleId: string, body: UpdateRuleRequest) => request<RuleView>("PATCH", `/rules/${ruleId}`, body),
    deleteRule: (ruleId: string) => request<void>("DELETE", `/rules/${ruleId}`),
    updateSuggestion: (suggestionId: string, status: SuggestionStatusName) =>
      request<void>("PATCH", `/suggestions/${suggestionId}`, { status }),
    reflect: () => request<void>("POST", "/reflection"),
  },
  jobs: {
    list: (filter: Partial<JobFilter> = {}) => request<JobPostingView[]>("GET", `/jobs${query(filter)}`),
    setStatus: (jobPostingId: string, status: JobStatusName) => request<JobPostingView>("PATCH", `/jobs/${jobPostingId}`, { status }),
  },
  documents: {
    list: () => request<DocumentView[]>("GET", "/documents"),
    upload: (name: string, file: File) => {
      const body = new FormData();
      body.append("name", name);
      body.append("file", file);
      return request<DocumentView>("POST", "/documents", body);
    },
    remove: (name: string) => request<void>("DELETE", `/documents/${encodeURIComponent(name)}`),
    fileUrl: (documentId: string) => `/api/documents/${documentId}/file`,
  },
  recipes: {
    list: () => request<RecipeSummaryView[]>("GET", "/recipes"),
    /** `name` is "<site>/<what>", the two path segments. */
    get: (name: string) => request<RecipeDetailView>("GET", `/recipes/${name.split("/").map(encodeURIComponent).join("/")}`),
    import: (body: ImportRecipeRequest) => request<RecipeDetailView>("POST", "/recipes", body),
    teach: (body: TeachRecipeRequest) => request<TeachStartedView>("POST", "/recipes/teach", body),
    /** M11-T3: the agent's fix for the broken latest version, approved (the next version) or discarded. */
    approveFix: (name: string) => request<RecipeDetailView>("POST", `/recipes/${name.split("/").map(encodeURIComponent).join("/")}/fix`),
    discardFix: (name: string) => request<RecipeDetailView>("DELETE", `/recipes/${name.split("/").map(encodeURIComponent).join("/")}/fix`),
  },
  builder: {
    /** Without a pipeline: chats about new pipelines, not saved yet. */
    list: (pipelineId?: string) => request<BuilderChatSummaryView[]>("GET", `/builder/chats${query({ pipelineId })}`),
    create: (pipelineId?: string) => request<BuilderChatView>("POST", "/builder/chats", { pipelineId }),
    get: (chatId: string) => request<BuilderChatView>("GET", `/builder/chats/${chatId}`),
    send: (chatId: string, text: string, suggestionId?: string) =>
      request<BuilderChatView>("POST", `/builder/chats/${chatId}/messages`, { text, suggestionId }),
    save: (chatId: string, messageId: string) => request<BuilderChatView>("POST", `/builder/chats/${chatId}/messages/${messageId}/save`),
    dryRun: (chatId: string, messageId: string) =>
      request<BuilderDryRunResponse>("POST", `/builder/chats/${chatId}/messages/${messageId}/dry-run`),
  },
};
