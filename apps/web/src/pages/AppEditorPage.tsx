import { checkAppSource, tabOf, type AppCheckView, type AppDesignerTab, type AppIssue } from "@realentity/storm-shared";
import { IconAlertTriangle, IconArrowBackUp, IconCircleCheck, IconDeviceFloppy, IconFile, IconLoader2 } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { parseDocument } from "yaml";
import { Issues } from "../components/AppIssues";
import { DraftTypeCard } from "../components/DraftTypeCard";
import { BuilderMarksBanner, EditorChat } from "../components/EditorChat";
import { PagesDesigner } from "../components/PagesDesigner";
import { RenameNote } from "../components/RenameNote";
import { appMarks, type BuilderMarks } from "../lib/builder-marks";
import { focusOf } from "../lib/focus";
import { StagesDesigner } from "../components/StagesDesigner";
import { AppProperties, TypesDesigner, type DesignerEdit } from "../components/TypesDesigner";
import { ErrorAlert, Loading, PageHeader } from "../components/ui";
import { APP_TEMPLATES, EMPTY_APP } from "../lib/apps";
import { api } from "../lib/endpoints";
import { asObject, loose, text } from "../lib/loose-app";
import { useAction, useLoad } from "../lib/use-load";

type Tab = Exclude<AppDesignerTab, "app"> | "yaml";
const TABS: { tab: Tab; label: string; intro: string }[] = [
  { tab: "types", label: "Types", intro: "What the App keeps: a table per type, a row per field. Pipelines save entities of these types." },
  {
    tab: "stages",
    label: "Stages",
    intro: "Where each entity is (new, applied, paid…) and the moves between the states, by you or a pipeline.",
  },
  { tab: "pages", label: "Pages", intro: "How the entities are shown: each type's list in the menu, and a page for each entity." },
  { tab: "yaml", label: "YAML", intro: "The App as it is saved, with its comments: everything the other tabs show, written out." },
];

/**
 * M35: the App designer. An App's YAML is what is saved; the tabs show it as types, stages and pages, and every change
 * made on them is an edit of the YAML (its comments and order kept). It is checked while editing: its problems on their tab
 * and line, the pipelines it would break, what it changes.
 */
export function AppEditorPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const existing = useLoad(() => (appId ? api.apps.get(appId) : Promise.resolve(null)), [appId]);
  const [source, setSource] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("types");
  const [line, setLine] = useState<number | null>(null);
  /** What the YAML was before each of the designer's edits, for Undo (typing on the YAML tab is its own). */
  const [undo, setUndo] = useState<string[]>([]);
  const check = useCheck(source, appId);
  // M38-T5: what the user is on (sent to the builder), and what its proposal changed once used here.
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [marks, setMarks] = useState<BuilderMarks | null>(null);
  const action = useAction();

  useEffect(() => {
    if (existing.data && source === null) setSource(existing.data.source);
  }, [existing.data, source]);

  if (appId && source === null) return existing.error ? <ErrorAlert error={existing.error} /> : <Loading />;
  if (source === null) return <StartFrom onStart={setSource} />;

  const app = loose(source);
  const errors = check.result?.errors ?? [];
  const onTab = (t: Tab) => (t === "yaml" ? errors.filter((e) => e.line !== undefined) : errors.filter((e) => tabOf(e.path) === t));
  const general = errors.filter((e) => tabOf(e.path) === "app");
  const showLine = (n: number) => {
    setTab("yaml");
    setLine(n);
  };

  const editable = parseDocument(source).errors.length === 0;
  const wide = tab === "stages" || tab === "pages";
  const edit = (change: DesignerEdit, note?: string) => {
    try {
      const next = change(source);
      if (next === source) return;
      setUndo((u) => [...u.slice(-49), source]);
      setSource(next);
      if (note) toast.info(note);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const entities = Object.fromEntries((existing.data?.types ?? []).map((t) => [t.name, t.entities]));

  const save = async () => {
    const saved = await action.run(() => (appId ? api.apps.save(appId, source) : api.apps.create(source)));
    if (!saved) return;
    toast.success(`Saved as v${saved.version}`);
    void navigate(`/apps/${saved.appId}`);
  };

  return (
    <>
      <PageHeader
        pretitle={existing.data ? <Link to={`/apps/${existing.data.appId}`}>{existing.data.name}</Link> : <Link to="/apps">Apps</Link>}
        title={existing.data ? `Design: next is v${(existing.data.version ?? 0) + 1}` : `New App: ${app.name ?? "…"}`}
        actions={
          <div className="btn-list">
            <button
              type="button"
              className="btn"
              disabled={undo.length === 0}
              onClick={() => {
                setSource(undo.at(-1)!);
                setUndo((u) => u.slice(0, -1));
                setMarks(null);
              }}
              data-testid="undo"
            >
              <IconArrowBackUp size={18} className="me-1" />
              Undo
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy || !source.trim()}
              onClick={() => void save()}
              data-testid="save-app"
            >
              <IconDeviceFloppy size={18} className="me-1" />
              Save
            </button>
          </div>
        }
      />
      <div className="row g-3">
        {/* M38-T1: the diagram and the pages take the page's width; the check goes under them. */}
        <div className={wide ? "col-12" : "col-xl-8"}>
          <ErrorAlert error={action.error} />
          <Issues issues={general} onLine={showLine} testId="app-issues" />
          <div className="card">
            <AppProperties
              app={app}
              icon={text(asObject(rootOf(source)).icon) || "list"}
              description={text(asObject(rootOf(source)).description)}
              onEdit={edit}
              editable={editable}
            />
            <div className="card-header">
              <ul className="nav nav-tabs card-header-tabs" role="tablist">
                {TABS.map(({ tab: t, label }) => {
                  const count = onTab(t).length;
                  return (
                    <li key={t} className="nav-item">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={t === tab}
                        className={`nav-link ${t === tab ? "active" : ""}`}
                        onClick={() => setTab(t)}
                        data-testid={`tab-${t}`}
                      >
                        {label}
                        {count > 0 && <span className="badge bg-red-lt ms-2">{count}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="card-body py-2 border-bottom small text-secondary" data-testid="tab-intro">
              {TABS.find((t) => t.tab === tab)?.intro} The tabs and the YAML are the same App: a change on one is on the other, and Undo
              takes back the tabs' changes.
            </div>
            {marks && (
              <div className="card-body pb-0">
                <BuilderMarksBanner marks={marks} onClear={() => setMarks(null)} />
              </div>
            )}
            {tab === "types" && (
              <div onFocusCapture={(e) => setFocus(`the Types tab, ${focusOf(e.target) ?? ""}`)}>
                <TypesDesigner
                  app={app}
                  issues={onTab("types")}
                  onLine={showLine}
                  onEdit={edit}
                  editable={editable}
                  entities={entities}
                  marked={marks?.marked}
                />
              </div>
            )}
            {tab === "stages" && <StagesDesigner app={app} issues={onTab("stages")} onLine={showLine} onEdit={edit} editable={editable} />}
            {tab === "pages" && (
              <PagesDesigner
                source={source}
                appId={appId}
                app={app}
                definition={checkAppSource(source).definition}
                issues={onTab("pages")}
                onLine={showLine}
                onEdit={edit}
                editable={editable}
              />
            )}
            {tab === "yaml" && <YamlTab source={source} onChange={setSource} issues={onTab("yaml")} line={line} onLine={setLine} />}
          </div>
        </div>
        <div className={`${wide ? "col-12" : "col-xl-4"} d-flex flex-column gap-3`}>
          <CheckCard check={check} isNew={!appId} />
          <EditorChat
            appId={appId}
            editor={() => ({ source, ...(focus ? { focus } : {}) })}
            onUse={({ kind, source: proposed }) => {
              if (kind !== "app") {
                toast.info("That is a pipeline: open it from the chat on the Pipelines page.");
                return;
              }
              const changed = appMarks(source, proposed);
              edit(() => proposed);
              setMarks(changed);
              setTab("types");
            }}
            placeholder='What to change, e.g. "Add a due date to Bill", or about the field you are on: "Should this be money?"'
          />
          {/* Kept while on the other tabs: a pasted sample or a dry run is still there on return. */}
          <div className={tab === "types" ? undefined : "d-none"}>
            <DraftTypeCard types={app.types.map(([name]) => name)} onEdit={edit} />
          </div>
        </div>
      </div>
    </>
  );
}

/** The draft checked a moment after typing stops; the last answer kept while the next one comes. */
function useCheck(source: string | null, appId: string | undefined) {
  const [result, setResult] = useState<{ source: string; view: AppCheckView } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (source === null) return;
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      api.apps
        .check(source, appId)
        .then((view) => {
          if (ticket !== latest.current) return;
          setResult({ source, view });
          setError(null);
        })
        .catch((e: unknown) => ticket === latest.current && setError(e));
    }, 400);
    return () => clearTimeout(timer);
  }, [source, appId]);
  return { result: result?.view ?? null, checking: result?.source !== source && !error, error };
}

/** A new App: from nothing, or from one of the ready-made ones. */
function StartFrom({ onStart }: { onStart: (source: string) => void }) {
  return (
    <>
      <PageHeader pretitle={<Link to="/apps">Apps</Link>} title="New App" />
      <div className="card mb-3" data-testid="start-intro">
        <div className="card-body">
          <p className="mb-2">
            An App is what you keep about something (jobs, bills, products) and how you see it. You build it in three parts, each on its own
            tab:
          </p>
          <ol className="mb-2">
            <li>
              <strong>Types</strong>: what one of them is: its fields (a title, an amount, a date…).
            </li>
            <li>
              <strong>Stages</strong> (if it has any): where each one is (new, applied, paid) and how it moves on.
            </li>
            <li>
              <strong>Pages</strong>: its list in the menu and a page for each one.
            </li>
          </ol>
          <p className="mb-0 text-secondary">
            Then pipelines fill it: a pipeline names the App with <code>app:</code> and saves its entities. Start from nothing, or from one
            of these and change it.
          </p>
        </div>
      </div>
      <div className="row row-cards" data-testid="start-from">
        <div className="col-md-6 col-xl-4">
          <button
            type="button"
            className="card card-link text-start w-100 h-100"
            onClick={() => onStart(EMPTY_APP)}
            data-testid="start-empty"
          >
            <div className="card-body">
              <h3 className="card-title mb-1">
                <IconFile size={18} className="me-1" />
                Empty
              </h3>
              <div className="text-secondary">One type with a name, to grow from</div>
            </div>
          </button>
        </div>
        {APP_TEMPLATES.map((t) => (
          <div key={t.name} className="col-md-6 col-xl-4">
            <button
              type="button"
              className="card card-link text-start w-100 h-100"
              onClick={() => onStart(t.source)}
              data-testid="start-template"
            >
              <div className="card-body">
                <h3 className="card-title mb-1">{t.name}</h3>
                <div className="text-secondary">{t.description}</div>
              </div>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function CheckCard({ check, isNew }: { check: ReturnType<typeof useCheck>; isNew: boolean }) {
  const view = check.result;
  const problems = (view?.errors.length ?? 0) + (view?.pipelines.length ?? 0);
  return (
    <div className="card" data-testid="app-check">
      <div className="card-header">
        <h3 className="card-title d-flex align-items-center gap-2">
          {check.checking || !view ? (
            <IconLoader2 size={18} className="text-secondary" />
          ) : problems > 0 ? (
            <IconAlertTriangle size={18} className="text-red" />
          ) : (
            <IconCircleCheck size={18} className="text-green" />
          )}
          {check.checking || !view ? "Checking…" : problems > 0 ? `${problems} problem${problems === 1 ? "" : "s"}` : "No problems"}
        </h3>
      </div>
      <div className={`card-body d-flex flex-column gap-3 ${!check.error && !(view && (problems > 0 || !isNew)) ? "d-none" : ""}`}>
        <ErrorAlert error={check.error} />
        {view && view.errors.length > 0 && <div className="text-secondary small">Each is on its tab, and on the YAML tab at its line.</div>}
        {view && view.pipelines.length > 0 && (
          <div data-testid="broken-pipelines">
            <div className="fw-bold mb-1">It would break</div>
            {view.pipelines.map((p) => (
              <div key={p.pipelineId} className="mb-2">
                <Link to={`/pipelines/${p.pipelineId}`}>{p.name}</Link>
                <ul className="small mb-0 ps-3">
                  {p.errors.map((e, i) => (
                    <li key={i}>
                      {e.path && <code className="me-1">{e.path}</code>}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {view?.renamed && <RenameNote renamed={view.renamed} what="pipeline" />}
        {!isNew && view && view.errors.length === 0 && (
          <div data-testid="app-changes">
            <div className="fw-bold mb-1">What changes</div>
            {view.changes.length === 0 ? (
              <div className="text-secondary small">Nothing yet</div>
            ) : (
              <ul className="small mb-0 ps-3">
                {view.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function YamlTab({
  source,
  onChange,
  issues,
  line,
  onLine,
}: {
  source: string;
  onChange: (source: string) => void;
  issues: AppIssue[];
  line: number | null;
  onLine: (line: number | null) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const sorted = useMemo(() => [...issues].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)), [issues]);
  useEffect(() => {
    const element = area.current;
    if (!element || line === null) return;
    const lines = source.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    element.focus();
    element.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    element.scrollTop = Math.max(0, (line - 5) * 20);
    onLine(null);
  }, [line, source, onLine]);
  return (
    <>
      {sorted.length > 0 && (
        <div className="card-body border-bottom">
          <Issues issues={sorted} onLine={onLine} testId="yaml-issues" />
        </div>
      )}
      <textarea
        ref={area}
        className="form-control border-0 font-monospace source-editor"
        rows={28}
        spellCheck={false}
        value={source}
        onChange={(e) => onChange(e.target.value)}
        aria-label="App definition"
        data-testid="app-source"
      />
    </>
  );
}

/** The YAML's top level, read loosely (nothing when it doesn't parse). */
function rootOf(source: string): unknown {
  try {
    return parseDocument(source).toJS() as unknown;
  } catch {
    return null;
  }
}
