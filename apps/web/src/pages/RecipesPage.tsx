import { type RecipeSummaryView } from "@realentity/storm-shared";
import { IconAlertTriangle, IconDownload, IconFileImport, IconLoader2, IconPencil, IconPlayerPlay, IconSchool } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { stringify } from "yaml";
import { Empty, ErrorAlert, Json, Loading, Modal, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/**
 * Site recipes (docs/design.md §2.4): how browser.extract reads a site's list, versioned. Taught in the live browser
 * (teach mode) or imported; a recipe whose page changed is marked broken until it works again or is taught anew.
 */
export function RecipesPage() {
  const recipes = useLoad(() => api.recipes.list(), [], (signal) => signal.type === "run");
  const [teaching, setTeaching] = useState<{ name: string } | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <>
      <PageHeader
        title="Recipes"
        pretitle="How sites are read"
        actions={
          <>
            <button type="button" className="btn" onClick={() => setImporting(true)}>
              <IconFileImport size={18} className="me-1" />
              Import
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setTeaching({ name: "" })} data-testid="teach">
              <IconSchool size={18} className="me-1" />
              Teach
            </button>
          </>
        }
      />
      <p className="text-secondary">
        <code>browser.extract</code> reads a site's list (job ads, a shop's search results) with its latest recipe, headless and without an LLM.
        To teach one, the live browser opens the site, you show it the list, and the LLM writes the selectors once; you check what it reads
        before it is saved. To watch one product's price, no recipe is needed: <code>shop.product</code> reads product pages.
      </p>
      <ErrorAlert error={recipes.error} />
      {!recipes.data && recipes.loading && <Loading />}
      {recipes.data?.length === 0 && <Empty>No recipes yet.</Empty>}
      {recipes.data && recipes.data.length > 0 && (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-vcenter card-table" data-testid="recipes">
              <thead>
                <tr>
                  <th>Recipe</th>
                  <th>Version</th>
                  <th>Health</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recipes.data.map((recipe) => (
                  <tr key={recipe.name}>
                    <td>
                      <Link to={`/recipes/${recipe.name}`}>
                        <code>{recipe.name}</code>
                      </Link>
                    </td>
                    <td>v{recipe.version}</td>
                    <td>
                      <Health recipe={recipe} />
                      {recipe.proposedAt && (
                        <div className="small">
                          <Link to={`/recipes/${recipe.name}`}>A fix is proposed: check it</Link>
                        </div>
                      )}
                    </td>
                    <td className="text-end">
                      <button type="button" className="btn btn-sm" onClick={() => setTeaching({ name: recipe.name })}>
                        Teach again
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {teaching && <TeachRecipe initialName={teaching.name} onClose={() => setTeaching(null)} />}
      {importing && (
        <ImportRecipe
          onClose={() => setImporting(false)}
          onSaved={() => {
            setImporting(false);
            recipes.reload();
          }}
        />
      )}
    </>
  );
}

function Health({ recipe }: { recipe: Pick<RecipeSummaryView, "brokenAt" | "brokenReason" | "lastVerifiedAt" | "lastItemsAt" | "quiet"> }) {
  if (recipe.brokenAt) {
    return (
      <span className="text-danger" title={recipe.brokenReason ?? undefined}>
        <IconAlertTriangle size={16} className="me-1" />
        Broken since {formatDateTime(recipe.brokenAt)}
        {recipe.brokenReason && <div className="small">{recipe.brokenReason}</div>}
      </span>
    );
  }
  if (recipe.quiet) {
    return (
      <span className="text-warning" title="Only its &quot;no results&quot; page for a week: the site may have changed">
        <IconAlertTriangle size={16} className="me-1" />
        Nothing found {recipe.lastItemsAt ? `since ${formatDateTime(recipe.lastItemsAt)}` : "yet"}
        <div className="small text-secondary">Its &quot;no results&quot; page every time: teach it again if the site changed.</div>
      </span>
    );
  }
  return recipe.lastVerifiedAt ? (
    <span className="text-success">Worked {formatDateTime(recipe.lastVerifiedAt)}</span>
  ) : (
    <span className="text-secondary">Not run yet</span>
  );
}

const RECIPE_ORDER = ["url", "params", "item", "fields", "key", "empty", "next", "detail", "maxPages", "delayMs"];
const FIELD_ORDER = ["selector", "attr", "required"];
const NEXT_ORDER = ["kind", "selector", "url", "start"];
const DETAIL_ORDER = ["link", "fields"];

/** `keys` first, in that order, then the rest as they are (the database keeps no order). */
function ordered(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const rank = (key: string) => (keys.includes(key) ? keys.indexOf(key) : keys.length);
  return Object.fromEntries(entries.sort(([a], [b]) => rank(a) - rank(b)));
}

/** A recipe as the YAML it is imported and edited as, its keys in the order of recipes/example-jobs.yaml. */
function recipeYaml(recipe: unknown): string {
  const orderFields = (fields: unknown) =>
    fields && typeof fields === "object"
      ? Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([field, spec]) => [field, ordered(spec, FIELD_ORDER)]))
      : fields;
  const top = ordered(recipe, RECIPE_ORDER) as Record<string, unknown> | null;
  if (top && typeof top === "object") {
    top.fields = orderFields(top.fields);
    if (top.next) top.next = ordered(top.next, NEXT_ORDER);
    if (top.detail && typeof top.detail === "object") {
      const detail = ordered(top.detail, DETAIL_ORDER) as Record<string, unknown>;
      top.detail = { ...detail, fields: orderFields(detail.fields) };
    }
  }
  return stringify(top, { lineWidth: 0 });
}

/** Saves a recipe as `<site>_<what>.yaml`, ready to import elsewhere. */
function downloadYaml(name: string, recipe: unknown) {
  const blob = new Blob([recipeYaml(recipe)], { type: "application/yaml" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${name.replace("/", "_")}.yaml`;
  link.click();
  URL.revokeObjectURL(link.href);
}

const FINISHED = new Set(["DONE", "FAILED", "ABORTED"]);
/** The item pages a Try opens for a recipe with a detail section (the api's TRY_DETAILS). */
const TRY_DETAILS = 5;

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The latest version's params, with their descriptions and defaults (a recipe the page can't read: none). */
function paramsOf(recipe: unknown): [string, { description?: string; default?: string }][] {
  const params = (recipe as { params?: unknown } | null)?.params;
  return params && typeof params === "object" ? Object.entries(params as Record<string, { description?: string; default?: string }>) : [];
}

/**
 * Try: a dry run with the latest version and the params given here, its items shown in place. It reads the site as a
 * run does, and changes nothing: the recipe isn't marked as working or broken, and nobody is told.
 */
function TryRecipe({ name, recipe, version }: Readonly<{ name: string; recipe: unknown; version: number }>) {
  const params = paramsOf(recipe);
  const shape = recipe as { fields?: Record<string, unknown>; detail?: { fields?: Record<string, unknown> } } | null;
  const fields = [...Object.keys(shape?.fields ?? {}), ...Object.keys(shape?.detail?.fields ?? {})];
  const [values, setValues] = useState<Record<string, string>>({});
  const [maxItems, setMaxItems] = useState(50);
  const [runId, setRunId] = useState<string | null>(null);
  const action = useAction();
  const run = useLoad(
    () => (runId ? api.runs.get(runId) : Promise.resolve(null)),
    [runId],
    (signal) => runId !== null && (signal.type === "run" || signal.type === "step") && signal.runId === runId,
  );
  const tried = run.data ?? null;
  const running = runId !== null && (!tried || !FINISHED.has(tried.status));
  const step = tried?.steps.find((s) => s.stepKey === "read");
  // With a detail section, the first items' own pages were opened too: their items have those fields.
  const details = tried?.steps.find((s) => s.stepKey === "details");
  const read = step?.status === "DONE" ? (step.output as { items: Record<string, string>[]; pages: number }) : null;
  const detailed = details?.status === "DONE" ? (details.output as { items: Record<string, string>[]; opened: number; found: number }) : null;
  const output = read && detailed ? { ...read, items: detailed.items } : read;
  const screenshot = tried?.artifacts.find((a) => a.kind === "screenshot");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ""));
    const started = await action.run(() => api.recipes.try(name, { params: filled, maxItems }));
    if (started) setRunId(started.runId);
  };

  return (
    <form className="card mb-3" data-testid="try-recipe" onSubmit={(e) => void submit(e)}>
      <div className="card-header">
        <h3 className="card-title">Try v{version}</h3>
      </div>
      <div className="card-body">
        <p className="text-secondary small">
          Reads the list now, as a run would, and shows what it finds{shape?.detail ? `, with the detail fields of the first ${TRY_DETAILS} items` : ""}. It changes nothing: the recipe isn&apos;t marked as working or broken,
          nobody is told, and the agent doesn&apos;t step in when it doesn&apos;t match. It still opens the site, at the recipe&apos;s pace.
        </p>
        <ErrorAlert error={action.error} />
        <div className="row g-2 align-items-end">
          {params.map(([param, spec]) => (
            <div className="col-sm-6 col-lg-4" key={param}>
              <label className={`form-label${spec.default === undefined ? " required" : ""}`} htmlFor={`try-${param}`}>
                {param}
              </label>
              <input
                id={`try-${param}`}
                className="form-control"
                placeholder={spec.default ?? ""}
                value={values[param] ?? ""}
                onChange={(e) => setValues({ ...values, [param]: e.target.value })}
                required={spec.default === undefined}
              />
              {spec.description && <div className="form-hint">{spec.description}</div>}
            </div>
          ))}
          <div className="col-sm-4 col-lg-2">
            <label className="form-label" htmlFor="try-max-items">
              Items at most
            </label>
            <input
              id="try-max-items"
              type="number"
              className="form-control"
              min={1}
              max={200}
              value={maxItems}
              onChange={(e) => setMaxItems(Number(e.target.value))}
            />
          </div>
          <div className="col-auto">
            <button type="submit" className="btn btn-primary" disabled={action.busy || running}>
              {running ? <IconLoader2 size={18} className="me-1" /> : <IconPlayerPlay size={18} className="me-1" />}
              {running ? "Reading…" : "Try"}
            </button>
          </div>
        </div>
      </div>
      {tried && FINISHED.has(tried.status) && (
        <div className="card-body border-top" data-testid="try-result">
          {output && (
            <>
              <p>
                {output.items.length === 0
                  ? `Nothing found on ${count(output.pages, "page")}: its "no results" page. Try a broader search.`
                  : `${count(output.items.length, "item")} on ${count(output.pages, "page")}.`}
                {detailed && ` Details from ${detailed.found} of the first ${count(detailed.opened, "item page")}.`}{" "}
                <Link to={`/runs/${tried.runId}`}>The run</Link>
              </p>
              {details?.status === "FAILED" && <div className="alert alert-warning">{details.error}</div>}
              {output.items.length > 0 && (
                <div className="table-responsive" style={{ maxHeight: 480 }}>
                  <table className="table table-sm table-vcenter" data-testid="try-items">
                    <thead>
                      <tr>
                        {fields.map((field) => (
                          <th key={field}>{field}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {output.items.map((item, index) => (
                        <tr key={`${index}-${item.url ?? ""}`}>
                          {fields.map((field) => (
                            <td key={field} className="text-break">
                              {field === "url" && item[field] ? (
                                <a href={item[field]} target="_blank" rel="noreferrer noopener">
                                  {item[field]}
                                </a>
                              ) : (
                                (item[field] ?? <span className="text-secondary">—</span>)
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {!output && (
            <>
              <div className="text-danger mb-2">
                {step?.error ?? `The try ended ${tried.status.toLowerCase()}.`} <Link to={`/runs/${tried.runId}`}>The run</Link>
              </div>
              {screenshot && <img src={api.artifactUrl(screenshot.artifactId)} alt="The page as the recipe saw it" className="img-fluid border rounded" />}
            </>
          )}
        </div>
      )}
    </form>
  );
}

/** One recipe's versions, newest first: each one as YAML, editable into the next version. */
export function RecipePage() {
  const { site = "", what = "" } = useParams();
  const name = `${site}/${what}`;
  const recipe = useLoad(() => api.recipes.get(name), [name], (signal) => signal.type === "run");
  const action = useAction();
  const [editing, setEditing] = useState<{ from: number; source: string } | null>(null);
  const [teaching, setTeaching] = useState(false);
  const latest = recipe.data?.versions[0];
  const decide = async (approve: boolean) => {
    const saved = await action.run(() => (approve ? api.recipes.approveFix(name) : api.recipes.discardFix(name)));
    if (!saved) return;
    toast.success(approve ? `Saved as v${saved.versions[0].version}` : "Fix discarded");
    recipe.reload();
  };
  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const saved = await action.run(() => api.recipes.import({ name, source: editing.source }));
    if (!saved) return;
    toast.success(`Saved as v${saved.versions[0].version}`);
    setEditing(null);
    recipe.reload();
  };
  return (
    <>
      <PageHeader
        title={<code>{name}</code>}
        pretitle={<Link to="/recipes">Recipes</Link>}
        actions={
          <button type="button" className="btn" onClick={() => setTeaching(true)}>
            <IconSchool size={18} className="me-1" />
            Teach again
          </button>
        }
      />
      <ErrorAlert error={recipe.error ?? (editing ? undefined : action.error)} />
      {teaching && <TeachRecipe initialName={name} onClose={() => setTeaching(false)} />}
      {editing && latest && (
        <form className="card mb-3 border-primary" data-testid="recipe-editor" onSubmit={(e) => void saveEdit(e)}>
          <div className="card-header">
            <h3 className="card-title">
              Edit {editing.from === latest.version ? `v${editing.from}` : `from v${editing.from}`}
            </h3>
          </div>
          <div className="card-body">
            <ErrorAlert error={action.error} />
            <label className="form-label" htmlFor="recipe-source">
              Recipe (YAML)
            </label>
            <textarea
              id="recipe-source"
              className="form-control font-monospace"
              rows={Math.min(30, Math.max(12, editing.source.split("\n").length + 2))}
              value={editing.source}
              onChange={(e) => setEditing({ ...editing, source: e.target.value })}
              spellCheck={false}
              required
            />
            <div className="form-hint">
              Checked before it is saved, like an import. Saved as v{latest.version + 1}, which runs use from then on; the versions before it stay.
            </div>
          </div>
          <div className="card-footer d-flex gap-2 justify-content-end">
            <button
              type="button"
              className="btn"
              onClick={() => {
                action.clearError();
                setEditing(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={action.busy}>
              Save as v{latest.version + 1}
            </button>
          </div>
        </form>
      )}
      {!recipe.data && recipe.loading && <Loading />}
      {latest?.proposed != null && (
        <div className="card mb-3 border-warning" data-testid="proposed-fix">
          <div className="card-header">
            <h3 className="card-title">A fix for v{latest.version}, proposed by the agent</h3>
            <div className="card-actions small text-secondary">
              {latest.proposedInRunId && <Link to={`/runs/${latest.proposedInRunId}`}>found</Link>} {latest.proposedAt && formatDateTime(latest.proposedAt)}
            </div>
          </div>
          <div className="card-body">
            <p className="text-secondary">
              v{latest.version} stopped matching the page; this recipe read it again and runs read with it until you decide. Approved, it is saved
              as v{latest.version + 1}.
            </p>
            <Json value={recipeYaml(latest.proposed)} />
          </div>
          <div className="card-footer d-flex gap-2 justify-content-end">
            <button type="button" className="btn btn-outline-danger" disabled={action.busy} onClick={() => void decide(false)}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void decide(true)} data-testid="approve-fix">
              Save as v{latest.version + 1}
            </button>
          </div>
        </div>
      )}
      {latest && <TryRecipe key={latest.version} name={name} recipe={latest.recipe} version={latest.version} />}
      {recipe.data?.versions.map((version, index) => (
        <div className="card mb-3" key={version.version}>
          <div className="card-header">
            <h3 className="card-title">
              v{version.version}
              {index === 0 && <span className="badge bg-blue-lt ms-2">in use</span>}
            </h3>
            <div className="card-actions d-flex align-items-center gap-2">
              <span className="small text-secondary">
                {version.taughtInRunId ? <Link to={`/runs/${version.taughtInRunId}`}>taught</Link> : "imported or edited"} {formatDateTime(version.dateCreated)}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => downloadYaml(name, version.recipe)}
                title="This version as a YAML file, to import elsewhere"
                aria-label={`Download v${version.version}`}
              >
                <IconDownload size={16} />
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  action.clearError();
                  setEditing({ from: version.version, source: recipeYaml(version.recipe) });
                  window.scrollTo({ top: 0 });
                }}
              >
                <IconPencil size={16} className="me-1" />
                {index === 0 ? "Edit" : "Edit from here"}
              </button>
            </div>
          </div>
          <div className="card-body">
            <div className="mb-2">
              <Health recipe={version} />
            </div>
            <Json value={recipeYaml(version.recipe)} />
          </div>
        </div>
      ))}
    </>
  );
}

/** What a list holds: the fields teach mode reads, what each one is, and an example to start from. */
const KINDS = {
  jobs: {
    label: "Job ads",
    fields: ["url", "title", "company", "location", "posted"],
    explain: "url (the ad's link, it identifies the ad), title, company, location, posted (the date shown).",
    example: { name: "jobs.example.com/search", url: "https://jobs.example.com/jobs/net/", params: "category=net", hint: "Leave out the promoted ads at the top." },
  },
  products: {
    label: "Products",
    fields: ["url", "title", "price"],
    explain: "url (the product's link, it identifies the product), title (brand and name), price (the current price; text like € 129,95 is fine).",
    example: {
      name: "bergfreunde.eu/search",
      url: "https://www.bergfreunde.eu/s/fjallraven-jacket",
      params: "query=fjallraven-jacket",
      hint: "The current selling price, not the crossed-out one. Leave out the recommended products below the list.",
    },
  },
  other: { label: "Something else", fields: [], explain: "", example: null },
} as const;
type Kind = keyof typeof KINDS;

/** Starts teach mode and opens its run, where the live browser waits for the user. */
function TeachRecipe({ initialName, onClose }: { initialName: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>("jobs");
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialName ? `https://${initialName.split("/")[0]}/` : "");
  const [params, setParams] = useState("");
  const [fields, setFields] = useState("");
  const [hint, setHint] = useState("");
  const action = useAction();
  const example = KINDS[kind].example;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const pairs = params
      .split(/[\n,]/)
      .map((line) => line.split("=").map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== "");
    const chosen = kind === "other" ? fields.split(/[\s,]+/).filter(Boolean) : [...KINDS[kind].fields];
    const started = await action.run(() =>
      api.recipes.teach({ name: name.trim(), url: url.trim(), params: Object.fromEntries(pairs), fields: chosen, hint: hint.trim() || undefined }),
    );
    if (!started) return;
    toast.info("Teach mode started: the live browser waits for you on the run page");
    void navigate(`/runs/${started.runId}`);
  };
  const fillExample = () => {
    if (!example) return;
    setName(example.name);
    setUrl(example.url);
    setParams(example.params);
    setHint(example.hint);
  };

  return (
    <Modal
      title="Teach a recipe"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="teach-form" className="btn btn-primary" disabled={action.busy}>
            Open the live browser
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      <ol className="text-secondary small ps-3" data-testid="teach-steps">
        <li>The run page opens, with the live browser on the list address.</li>
        <li>
          There, bring the page to the list: accept the cookie banner, search, set filters. Then press <strong>Continue</strong>.
        </li>
        <li>
          The LLM writes the recipe and it is checked on the page; what it reads is outlined. Right: press <strong>Continue</strong> again to save
          it. Wrong: <strong>Abort</strong>.
        </li>
      </ol>
      <p className="text-secondary small">
        Teach on a search with several results (a broad one is best): pipelines set the search themselves, through the params. Teaching usually
        costs a few cents, a retry a fraction of that; runs with the recipe cost nothing.
      </p>
      <form id="teach-form" onSubmit={(e) => void submit(e)}>
        <div className="mb-3">
          <label className="form-label" htmlFor="teach-kind">
            The list holds
          </label>
          <div className="d-flex gap-2">
            <select id="teach-kind" className="form-select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {Object.entries(KINDS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
            {example && (
              <button type="button" className="btn text-nowrap" onClick={fillExample}>
                Fill in an example
              </button>
            )}
          </div>
          {kind === "other" ? (
            <>
              <input
                id="teach-fields"
                className="form-control mt-2"
                placeholder="url, title, date"
                value={fields}
                onChange={(e) => setFields(e.target.value)}
                aria-label="Fields"
                required
              />
              <div className="form-hint">The fields to read, comma-separated; url (the item&apos;s link) identifies each item.</div>
            </>
          ) : (
            <div className="form-hint">Reads {KINDS[kind].explain}</div>
          )}
        </div>
        <div className="mb-3">
          <label className="form-label required" htmlFor="teach-name">
            Name
          </label>
          <input
            id="teach-name"
            className="form-control"
            placeholder={example?.name ?? "site.com/list"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <div className="form-hint">
            <code>&lt;site&gt;/&lt;what&gt;</code>: the recipe only ever opens pages on that site. Pipelines use it by this name.
          </div>
        </div>
        <div className="mb-3">
          <label className="form-label required" htmlFor="teach-url">
            List address
          </label>
          <input
            id="teach-url"
            className="form-control"
            placeholder={example?.url ?? "https://site.com/list"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <div className="form-hint">Where the list is, as the browser shows it after a search.</div>
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="teach-params">
            Params
          </label>
          <input
            id="teach-params"
            className="form-control"
            placeholder={example?.params ?? "query=jacket"}
            value={params}
            onChange={(e) => setParams(e.target.value)}
          />
          <div className="form-hint">
            Parts of the address that pipelines will change, as name=value (comma-separated), the value exactly as it is in the address. For{" "}
            <code>…/s/fjallraven-jacket</code> that is <code>query=fjallraven-jacket</code>; a pipeline then sets <code>query</code>.
          </div>
        </div>
        <div>
          <label className="form-label" htmlFor="teach-hint">
            Hint for the LLM
          </label>
          <textarea
            id="teach-hint"
            className="form-control"
            rows={2}
            placeholder={example?.hint ?? "What to read or leave out"}
            value={hint}
            onChange={(e) => setHint(e.target.value)}
          />
          <div className="form-hint">Optional: what to leave out (ads, recommendations), or which of two prices is the right one.</div>
        </div>
      </form>
    </Modal>
  );
}

function ImportRecipe({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const action = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await action.run(() => api.recipes.import({ name: name.trim(), source }));
    if (!saved) return;
    toast.info(`Saved ${saved.name} v${saved.versions[0].version}`);
    onSaved();
  };
  return (
    <Modal
      title="Import a recipe"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="import-form" className="btn btn-primary" disabled={action.busy}>
            Save as the next version
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      <form id="import-form" onSubmit={(e) => void submit(e)}>
        <div className="mb-3">
          <label className="form-label required" htmlFor="import-name">
            Name
          </label>
          <input id="import-name" className="form-control" placeholder="jobs.example.com/search" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <label className="form-label required" htmlFor="import-source">
          Recipe (YAML or JSON)
        </label>
        <textarea
          id="import-source"
          className="form-control font-monospace"
          rows={14}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          required
          spellCheck={false}
        />
      </form>
    </Modal>
  );
}
