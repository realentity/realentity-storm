import { type RecipeSummaryView } from "@ai-me/shared";
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
        <code>browser.extract</code> reads a site's list with its latest recipe, headless and without an LLM. To teach one, the live browser opens
        the site, you show it the list, and the LLM writes the selectors; you check what it reads before it is saved.
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

function Health({ recipe }: { recipe: Pick<RecipeSummaryView, "brokenAt" | "brokenReason" | "lastVerifiedAt"> }) {
  if (recipe.brokenAt) {
    return (
      <span className="text-danger" title={recipe.brokenReason ?? undefined}>
        <IconAlertTriangle size={16} className="me-1" />
        Broken since {formatDateTime(recipe.brokenAt)}
        {recipe.brokenReason && <div className="small">{recipe.brokenReason}</div>}
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
  return (
    <>
      <PageHeader title={<code>{name}</code>} pretitle={<Link to="/recipes">Recipes</Link>} />
      <ErrorAlert error={recipe.error} />
      {!recipe.data && recipe.loading && <Loading />}
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

/** Starts teach mode and opens its run, where the live browser waits for me. */
function TeachRecipe({ initialName, onClose }: { initialName: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialName ? `https://${initialName.split("/")[0]}/` : "");
  const [params, setParams] = useState("");
  const [hint, setHint] = useState("");
  const action = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const pairs = params
      .split(/[\n,]/)
      .map((line) => line.split("=").map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== "");
    const started = await action.run(() =>
      api.recipes.teach({ name: name.trim(), url: url.trim(), params: Object.fromEntries(pairs), hint: hint.trim() || undefined }),
    );
    if (!started) return;
    toast.info("Teach mode started: the live browser opens on the run page");
    void navigate(`/runs/${started.runId}`);
  };

  return (
    <Modal
      title="Teach a recipe"
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
      <form id="teach-form" onSubmit={(e) => void submit(e)}>
        <div className="mb-3">
          <label className="form-label required" htmlFor="teach-name">
            Name
          </label>
          <input id="teach-name" className="form-control" placeholder="dev.bg/search" value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="form-hint">
            <code>&lt;site&gt;/&lt;what&gt;</code>: the recipe only ever opens pages on that site.
          </div>
        </div>
        <div className="mb-3">
          <label className="form-label required" htmlFor="teach-url">
            List address
          </label>
          <input
            id="teach-url"
            className="form-control"
            placeholder="https://dev.bg/company/jobs/net/"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="teach-params">
            Params
          </label>
          <input id="teach-params" className="form-control" placeholder="category=net" value={params} onChange={(e) => setParams(e.target.value)} />
          <div className="form-hint">Values in the address that pipelines will set, as name=value (comma-separated).</div>
        </div>
        <div>
          <label className="form-label" htmlFor="teach-hint">
            Hint for the LLM
          </label>
          <textarea id="teach-hint" className="form-control" rows={2} value={hint} onChange={(e) => setHint(e.target.value)} />
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
