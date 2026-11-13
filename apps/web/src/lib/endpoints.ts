import {
  type ApplyTopicBackfillRequest,
  type TopicBackfillRequest,
  type TopicBackfillView,
  type MergeTopicRequest,
  type SplitTopicRequest,
  type TopicChangeView,
  type TopicFactNoLongerTrueRequest,
  type TopicFactRequest,
  type TopicFactView,
  type TopicDirectionRequest,
  type TopicLinkView,
  type TopicSourceRequest,
  type TopicSourceView,
  type TopicSuggestionView,
  type TopicUpkeepView,
  type TopicRequest,
  type TopicUpdateRequest,
  type TopicView,
  type AppDetailView,
  type AppDriftView,
  type AppImportResult,
  type ImportSource,
  type AppEntityView,
  type AppListQuery,
  type AppListView,
  type AppMenuItem,
  type AppSummaryView,
  type AppCheckView,
  type ChecklistView,
  type ExampleNeed,
  type SetupView,
  type AppMapView,
  type AppPreviewView,
  type BundleCheckView,
  type BundleExportView,
  type DraftTypeRequest,
  type DraftTypeView,
  type EntityListView,
  type EntityQuery,
  type PricesStatusView,
  type HealthView,
  type PriceHistoryView,
  type WatchedProductRequest,
  type WatchedProductView,
  type BillsView,
  type CostsView,
  type BillView,
  type ApplicationView,
  type ApproveProposalRequest,
  type BuilderChatSummaryView,
  type BuilderChatView,
  type BuilderDryRunResponse,
  type CompilePipelineResponse,
  type CreateCredentialRequest,
  type CreateRuleRequest,
  type CredentialView,
  type DocumentView,
  type FileRef,
  type DryRunPipelineResponse,
  type FactRequest,
  type FactView,
  type GoogleStatusView,
  type ImportRecipeRequest,
  type InsightView,
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
  type QuestionView,
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
  type SpendingView,
  type StepTypeView,
  type TriggerDataView,
  type SuggestionStatusName,
  type TeachRecipeRequest,
  type TeachStartedView,
  type UpdateApplicationRequest,
  type UpdatePipelineRequest,
  type WebhookView,
  type UpdateRuleRequest,
  type ViewMenuItem,
  type ViewPageView,
  type ViewQuery,
  type ViewRow,
  type ViewRowView,
} from "@realentity/storm-shared";
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
    triggers: () => request<TriggerDataView>("GET", "/steps/triggers"),
  },
  pipelines: {
    list: () => request<PipelineSummaryView[]>("GET", "/pipelines"),
    get: (pipelineId: string) => request<PipelineDetailView>("GET", `/pipelines/${pipelineId}`),
    remove: (pipelineId: string) => request<void>("DELETE", `/pipelines/${pipelineId}`),
    version: (pipelineId: string, version: number) => request<PipelineVersionView>("GET", `/pipelines/${pipelineId}/versions/${version}`),
    compile: (source: string, pipelineId?: string) =>
      request<CompilePipelineResponse>("POST", "/pipelines/compile", { source, pipelineId }),
    dryRun: (source: string, pipelineId?: string, stopAfter?: string) =>
      request<DryRunPipelineResponse>("POST", "/pipelines/dry-run", { source, pipelineId, ...(stopAfter ? { stopAfter } : {}) }),
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
    retry: (runId: string) => request<RunDetailView>("POST", `/runs/${runId}/retry`),
  },
  /** Runs waiting for the user in the live view. */
  takeovers: () => request<(TakeoverView & { runId: string; pipelineName: string })[]>("GET", "/takeovers"),
  /** A run's file (screenshot, trace, download): an address for <img> or a download link. */
  artifactUrl: (artifactId: string) => `/api/artifacts/${artifactId}`,
  proposals: {
    list: (status: ProposalStatusName = "PENDING_REVIEW") => request<ProposalView[]>("GET", `/proposals${query({ status })}`),
    get: (proposalId: string) => request<ProposalView>("GET", `/proposals/${proposalId}`),
    approve: (proposalId: string, body: Partial<ApproveProposalRequest>) =>
      request<ProposalView>("POST", `/proposals/${proposalId}/approve`, body),
    reject: (proposalId: string, reason?: string) => request<ProposalView>("POST", `/proposals/${proposalId}/reject`, { reason }),
    undoReject: (proposalId: string) => request<ProposalView>("POST", `/proposals/${proposalId}/undo-reject`),
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
  facts: {
    list: () => request<FactView[]>("GET", "/facts"),
    create: (body: FactRequest) => request<FactView>("POST", "/facts", body),
    update: (factId: string, body: FactRequest) => request<FactView>("PUT", `/facts/${factId}`, body),
    remove: (factId: string) => request<void>("DELETE", `/facts/${factId}`),
  },
  topics: {
    list: () => request<TopicView[]>("GET", "/topics"),
    create: (body: TopicRequest) => request<TopicView>("POST", "/topics", body),
    update: (topicId: string, body: TopicUpdateRequest) => request<TopicView>("PUT", `/topics/${topicId}`, body),
    remove: (topicId: string) => request<void>("DELETE", `/topics/${topicId}`),
    addDirection: (topicId: string, body: TopicDirectionRequest) => request<TopicView>("POST", `/topics/${topicId}/directions`, body),
    removeDirection: (topicId: string, directionId: string) => request<TopicView>("DELETE", `/topics/${topicId}/directions/${directionId}`),
    links: (topicId: string) => request<TopicLinkView[]>("GET", `/topics/${topicId}/links`),
    facts: (topicId: string) => request<TopicFactView[]>("GET", `/topics/${topicId}/facts`),
    addFact: (topicId: string, body: TopicFactRequest) => request<TopicFactView>("POST", `/topics/${topicId}/facts`, body),
    changes: (topicId: string) => request<TopicChangeView[]>("GET", `/topics/${topicId}/changes`),
    upkeep: () => request<TopicUpkeepView>("GET", "/topics/upkeep"),
    replies: () => request<TopicUpkeepView>("GET", "/topics/replies"),
    tidy: () => request<TopicUpkeepView>("GET", "/topics/tidy"),
    split: (topicId: string, body: SplitTopicRequest) => request<{ topicId: string }>("POST", `/topics/${topicId}/split`, body),
    merge: (topicId: string, body: MergeTopicRequest) => request<{ disputed: number }>("POST", `/topics/${topicId}/merge`, body),
    sources: (topicId: string) => request<TopicSourceView[]>("GET", `/topics/${topicId}/sources`),
    addSource: (topicId: string, body: TopicSourceRequest) => request<TopicSourceView>("POST", `/topics/${topicId}/sources`, body),
    backfill: (topicId: string) => request<TopicBackfillView | null>("GET", `/topics/${topicId}/backfill`),
    estimateBackfill: (topicId: string, body: TopicBackfillRequest) =>
      request<TopicBackfillView>("POST", `/topics/${topicId}/backfill`, body),
  },
  topicFacts: {
    edit: (topicFactId: string, body: TopicFactRequest) => request<TopicFactView>("PUT", `/topic-facts/${topicFactId}`, body),
    noLongerTrue: (topicFactId: string, body: TopicFactNoLongerTrueRequest) =>
      request<TopicFactView>("POST", `/topic-facts/${topicFactId}/no-longer-true`, body),
    wrong: (topicFactId: string) => request<void>("POST", `/topic-facts/${topicFactId}/wrong`),
    settle: (topicFactId: string) => request<TopicFactView>("POST", `/topic-facts/${topicFactId}/settle`),
    move: (topicFactId: string, topicId: string) => request<TopicFactView>("POST", `/topic-facts/${topicFactId}/move`, { topicId }),
    undo: (topicChangeId: string) => request<void>("POST", `/topic-changes/${topicChangeId}/undo`),
  },
  topicSuggestions: {
    open: () => request<TopicSuggestionView[]>("GET", "/topic-suggestions"),
    accept: (id: string) => request<TopicSuggestionView>("POST", `/topic-suggestions/${id}/accept`),
    dismiss: (id: string) => request<TopicSuggestionView>("POST", `/topic-suggestions/${id}/dismiss`),
  },
  topicBackfills: {
    start: (id: string) => request<TopicBackfillView>("POST", `/topic-backfills/${id}/start`),
    cancel: (id: string) => request<TopicBackfillView>("POST", `/topic-backfills/${id}/cancel`),
    apply: (id: string, body: ApplyTopicBackfillRequest) => request<TopicBackfillView>("POST", `/topic-backfills/${id}/apply`, body),
  },
  topicSources: {
    remove: (topicSourceId: string) => request<void>("DELETE", `/topic-sources/${topicSourceId}`),
    rebuild: (topicSourceId: string) => request<TopicSourceView>("POST", `/topic-sources/${topicSourceId}/rebuild`),
  },
  topicLinks: {
    waiting: () => request<TopicLinkView[]>("GET", "/topic-links/waiting"),
    confirm: (topicLinkId: string) => request<TopicLinkView>("POST", `/topic-links/${topicLinkId}/confirm`),
    reject: (topicLinkId: string) => request<TopicLinkView>("POST", `/topic-links/${topicLinkId}/reject`),
    move: (topicLinkId: string, topicId: string) => request<TopicLinkView>("POST", `/topic-links/${topicLinkId}/move`, { topicId }),
  },
  questions: {
    answer: (questionId: string, answer: string) => request<QuestionView>("POST", `/questions/${questionId}/answer`, { answer }),
  },
  google: {
    status: () => request<GoogleStatusView>("GET", "/google"),
    connect: (returnTo?: string) => request<{ url: string }>("POST", "/google/connect", returnTo ? { returnTo } : {}),
    disconnect: () => request<void>("DELETE", "/google"),
  },
  scheduledStarts: {
    list: (pipelineId?: string) =>
      request<ScheduledStartView[]>("GET", `/scheduled-starts${pipelineId ? `?pipelineId=${pipelineId}` : ""}`),
    cancel: (id: string) => request<void>("DELETE", `/scheduled-starts/${id}`),
  },
  prices: {
    list: () => request<WatchedProductView[]>("GET", "/prices"),
    create: (body: WatchedProductRequest) => request<WatchedProductView>("POST", "/prices", body),
    update: (id: string, body: WatchedProductRequest) => request<WatchedProductView>("PUT", `/prices/${id}`, body),
    remove: (id: string) => request<void>("DELETE", `/prices/${id}`),
    history: (id: string) => request<PriceHistoryView>("GET", `/prices/${id}/history`),
    status: () => request<PricesStatusView>("GET", "/prices/status"),
    createPipeline: () => request<PipelineDetailView>("POST", "/prices/pipeline"),
  },
  costs: {
    get: (days: number) => request<CostsView>("GET", `/costs?days=${days}`),
  },
  health: {
    get: () => request<HealthView>("GET", "/health/checks"),
  },
  /** Pipelines' pages (M27). A row's key may be a URL: always encoded. */
  views: {
    menu: () => request<ViewMenuItem[]>("GET", "/views"),
    page: (pipelineId: string, q: Partial<ViewQuery> = {}) => request<ViewPageView>("GET", `/views/${pipelineId}${query(q)}`),
    row: (pipelineId: string, key: string) => request<ViewRowView>("GET", `/views/${pipelineId}/rows/${encodeURIComponent(key)}`),
    mark: (pipelineId: string, key: string, markId: string, on: boolean) =>
      request<ViewRow>("PUT", `/views/${pipelineId}/rows/${encodeURIComponent(key)}/marks/${markId}`, { on }),
    act: (pipelineId: string, index: number, key?: string) =>
      request<RunDetailView>("POST", `/views/${pipelineId}/actions/${index}`, key === undefined ? {} : { key }),
  },
  apps: {
    list: () => request<AppSummaryView[]>("GET", "/apps"),
    get: (appId: string) => request<AppDetailView>("GET", `/apps/${appId}`),
    create: (source: string) => request<AppDetailView>("POST", "/apps", { source }),
    save: (appId: string, source: string) => request<AppDetailView>("PUT", `/apps/${appId}`, { source }),
    /** The App itself (`remove` is an entity's). */
    removeApp: (appId: string) => request<void>("DELETE", `/apps/${appId}`),
    check: (source: string, appId?: string) => request<AppCheckView>("POST", "/apps/check", appId ? { source, appId } : { source }),
    preview: (source: string, type: string, appId?: string) =>
      request<AppPreviewView>("POST", "/apps/preview", appId ? { source, type, appId } : { source, type }),
    entities: (appId: string, type: string, q: Partial<EntityQuery> = {}) =>
      request<EntityListView>(
        "GET",
        `/apps/${appId}/types/${encodeURIComponent(type)}/entities${query({ ...q, removed: q.removed ? "true" : undefined })}`,
      ),
    draftType: (body: DraftTypeRequest) => request<DraftTypeView>("POST", "/apps/draft-type", body),
    draftTypeFromSample: (sample: unknown) => request<DraftTypeView>("POST", "/apps/draft-type/sample", { sample }),
    drift: (appId: string) => request<AppDriftView[]>("GET", `/apps/${appId}/drift`),
    map: (appId: string) => request<AppMapView>("GET", `/apps/${appId}/map`),
    addField: (appId: string, type: string, field: string) => request<AppDetailView>("POST", `/apps/${appId}/drift`, { type, field }),
    importFrom: (appId: string, from: ImportSource, into?: { collection: string; type: string }) =>
      request<AppImportResult>("POST", `/apps/${appId}/import`, { from, ...into }),
    menu: () => request<AppMenuItem[]>("GET", "/apps/menu"),
    page: (appId: string, type: string, q: Partial<AppListQuery> = {}) =>
      request<AppListView>("GET", `/apps/${appId}/pages/${encodeURIComponent(type)}${query(q)}`),
    entity: (appId: string, type: string, key: string) =>
      request<AppEntityView>("GET", `/apps/${appId}/pages/${encodeURIComponent(type)}/${encodeURIComponent(key)}`),
    add: (appId: string, type: string, values: Record<string, unknown>) =>
      request<AppEntityView>("POST", `/apps/${appId}/pages/${encodeURIComponent(type)}`, { values }),
    /** M46: a file or image for a form's field; the form's save attaches it. */
    upload: (appId: string, type: string, field: string, file: File) => {
      const body = new FormData();
      body.set("type", type);
      body.set("field", field);
      body.set("file", file);
      return request<FileRef>("POST", `/apps/${appId}/files`, body);
    },
    fileUrl: (fileId: string) => `/api/app-files/${fileId}`,
    thumbUrl: (fileId: string) => `/api/app-files/${fileId}/thumb`,
    saveValues: (appId: string, type: string, key: string, values: Record<string, unknown>) =>
      request<AppEntityView>("PUT", `/apps/${appId}/pages/${encodeURIComponent(type)}/${encodeURIComponent(key)}/values`, { values }),
    move: (appId: string, type: string, key: string, to: string) =>
      request<AppEntityView>("PUT", `/apps/${appId}/pages/${encodeURIComponent(type)}/${encodeURIComponent(key)}/stage`, { to }),
    remove: (appId: string, type: string, key: string) =>
      request<void>("DELETE", `/apps/${appId}/pages/${encodeURIComponent(type)}/${encodeURIComponent(key)}`),
    act: (appId: string, type: string, index: number, key?: string) =>
      request<RunDetailView>("POST", `/apps/${appId}/actions/${encodeURIComponent(type)}/${index}`, key === undefined ? {} : { key }),
  },
  bundles: {
    check: (text: string) => request<BundleCheckView>("POST", "/bundles/check", { text }),
    /** M40-T2: from an example: kept with its App, for its checklist. */
    save: (text: string, example?: { id: string; needs: ExampleNeed[] }) =>
      request<BundleCheckView>("POST", "/bundles", example ? { text, example } : { text }),
    exportApp: (appId: string) => request<BundleExportView>("GET", `/bundles/apps/${appId}`),
    exportPipeline: (pipelineId: string) => request<BundleExportView>("GET", `/bundles/pipelines/${pipelineId}`),
  },
  bills: {
    list: () => request<BillsView>("GET", "/bills"),
    paid: (billId: string, paid: boolean) => request<BillView>("PUT", `/bills/${billId}/paid`, { paid }),
  },
  settings: {
    get: () => request<SettingsView>("GET", "/settings"),
    update: (body: SettingsRequest) => request<SettingsView>("PUT", "/settings", body),
    spending: () => request<SpendingView>("GET", "/settings/spending"),
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
    setOutcome: (applicationId: string, body: UpdateApplicationRequest) =>
      request<ApplicationView>("PATCH", `/applications/${applicationId}`, body),
  },
  insight: {
    get: (days: number) => request<InsightView>("GET", `/insight?days=${days}`),
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
  examples: {
    setup: () => request<SetupView>("GET", "/examples/setup"),
    checklist: (appId: string) => request<ChecklistView | null>("GET", `/examples/apps/${appId}/checklist`),
  },
  builder: {
    /** Without a pipeline: chats about new pipelines, not saved yet. */
    list: (pipelineId?: string, appId?: string) =>
      request<BuilderChatSummaryView[]>("GET", `/builder/chats${query({ pipelineId, appId })}`),
    create: (pipelineId?: string, appId?: string) => request<BuilderChatView>("POST", "/builder/chats", { pipelineId, appId }),
    get: (chatId: string) => request<BuilderChatView>("GET", `/builder/chats/${chatId}`),
    /** M38-T5: from an editor, with what it has open and what the user is on there. */
    send: (chatId: string, text: string, suggestionId?: string, editor?: { source: string; focus?: string }) =>
      request<BuilderChatView>("POST", `/builder/chats/${chatId}/messages`, { text, suggestionId, ...(editor ? { editor } : {}) }),
    save: (chatId: string, messageId: string) => request<BuilderChatView>("POST", `/builder/chats/${chatId}/messages/${messageId}/save`),
    dryRun: (chatId: string, messageId: string) =>
      request<BuilderDryRunResponse>("POST", `/builder/chats/${chatId}/messages/${messageId}/dry-run`),
    saveApp: (chatId: string, messageId: string) =>
      request<BuilderChatView>("POST", `/builder/chats/${chatId}/messages/${messageId}/save-app`),
  },
};
