import { type RecipeSummaryView } from "@realentity/storm-shared";
import { IconAlertTriangle, IconFileImport, IconSchool } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { Empty, ErrorAlert, Json, Loading, Modal, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/**
 * Site recipes (README §2.4): how browser.extract reads a site's list, versioned. Taught in the live browser
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

/** One recipe's versions, newest first. */
export function RecipePage() {
  const { site = "", what = "" } = useParams();
  const name = `${site}/${what}`;
  const recipe = useLoad(() => api.recipes.get(name), [name], (signal) => signal.type === "run");
  const action = useAction();
  const latest = recipe.data?.versions[0];
  const decide = async (approve: boolean) => {
    const saved = await action.run(() => (approve ? api.recipes.approveFix(name) : api.recipes.discardFix(name)));
    if (!saved) return;
    toast.success(approve ? `Saved as v${saved.versions[0].version}` : "Fix discarded");
    recipe.reload();
  };
  return (
    <>
      <PageHeader title={<code>{name}</code>} pretitle={<Link to="/recipes">Recipes</Link>} />
      <ErrorAlert error={recipe.error ?? action.error} />
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
            <Json value={latest.proposed} />
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
      {recipe.data?.versions.map((version, index) => (
        <div className="card mb-3" key={version.version}>
          <div className="card-header">
            <h3 className="card-title">
              v{version.version}
              {index === 0 && <span className="badge bg-blue-lt ms-2">in use</span>}
            </h3>
            <div className="card-actions small text-secondary">
              {version.taughtInRunId ? <Link to={`/runs/${version.taughtInRunId}`}>taught</Link> : "imported"} {formatDateTime(version.dateCreated)}
            </div>
          </div>
          <div className="card-body">
            <div className="mb-2">
              <Health recipe={version} />
            </div>
            <Json value={version.recipe} />
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
    example: { name: "dev.bg/search", url: "https://dev.bg/company/jobs/net/", params: "category=net", hint: "Leave out the promoted ads at the top." },
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

/** Starts teach mode and opens its run, where the live browser waits for me. */
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
          <input id="import-name" className="form-control" placeholder="dev.bg/search" value={name} onChange={(e) => setName(e.target.value)} required />
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
