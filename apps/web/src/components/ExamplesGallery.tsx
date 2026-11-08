import { appMap, freeNames, joinBundle, needMet, splitBundle, type AppSummaryView, type SetupView } from "@realentity/storm-shared";
import { IconCheck, IconDownload, IconMap, IconSparkles, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { useCatalog } from "../lib/catalog";
import { api } from "../lib/endpoints";
import { EXAMPLES, type ExampleEntry } from "../lib/examples";
import { useAction, useLoad } from "../lib/use-load";
import { AppMap } from "./AppMap";
import { ErrorAlert } from "./ui";

/**
 * M40-T2: examples to start from: an App with the pipelines that fill it, what each needs set up (ticked when it is),
 * its map, and Install: imported as one file, its pipelines off; installed again, under names of its own.
 */
export function ExamplesGallery({ apps, onInstalled }: Readonly<{ apps: AppSummaryView[]; onInstalled?: () => void }>) {
  const setup = useLoad(() => api.examples.setup(), []);
  const action = useAction();
  const navigate = useNavigate();
  const install = async (example: ExampleEntry) => {
    const done = await action.run(async () => {
      const [apps, pipelines] = await Promise.all([api.apps.list(), api.pipelines.list()]);
      const taken = { apps: apps.map((a) => a.name), pipelines: pipelines.map((p) => p.name) };
      const text = joinBundle(freeNames(splitBundle(example.bundle), taken));
      return api.bundles.save(text, { id: example.id, needs: example.needs });
    });
    const appId = done?.items.find((i) => i.kind === "app")?.id;
    if (!appId) return;
    toast.success(`Installed ${example.name}: its pipelines are off until you switch them on`);
    onInstalled?.();
    void navigate(`/apps/${appId}`);
  };
  return (
    <div className="mt-4" data-testid="examples">
      <h2 className="mb-1">Examples to start from</h2>
      <p className="text-secondary">
        An App with the pipelines that fill it, ready to install. Its pipelines start off: try them, then switch them on. Installed twice,
        it is two.
      </p>
      <ErrorAlert error={action.error} />
      <div className="row row-cards">
        {EXAMPLES.map((example) => (
          <ExampleCard
            key={example.id}
            example={example}
            setup={setup.data ?? null}
            installed={installedAs(example, apps)}
            busy={action.busy}
            onInstall={() => void install(example)}
          />
        ))}
      </div>
    </div>
  );
}

/** An App of mine installed from it, or of its App's name (made from the same template): installing it again copies it. */
function installedAs(example: ExampleEntry, apps: AppSummaryView[]): AppSummaryView | undefined {
  return apps.find((a) => a.example === example.id) ?? apps.find((a) => a.name === example.app?.name);
}

function ExampleCard({
  example,
  setup,
  installed,
  busy,
  onInstall,
}: Readonly<{ example: ExampleEntry; setup: SetupView | null; installed?: AppSummaryView; busy: boolean; onInstall: () => void }>) {
  const [showMap, setShowMap] = useState(false);
  const catalog = useCatalog();
  const map =
    showMap && example.app
      ? appMap(example.app, example.pipelines, {}, (type) => catalog.find((s) => s.type === type)?.entities ?? [])
      : null;
  return (
    <div className={example.starter ? "col-12" : "col-md-6"}>
      <div className={`card h-100 ${example.starter ? "border-primary" : ""}`} data-testid="example-card" data-example={example.id}>
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-1">
            {example.starter && <IconSparkles size={18} className="text-primary" />}
            <h3 className="card-title mb-0">{example.name}</h3>
            {example.starter && !installed && <span className="badge bg-primary-lt">start here</span>}
            {installed && (
              <span className="badge bg-success-lt" data-testid="example-installed">
                installed
              </span>
            )}
          </div>
          <div className="text-secondary mb-2">{example.description}</div>
          <div className="small mb-1 fw-bold">What it needs</div>
          {example.needs.length === 0 ? (
            <div className="small text-success mb-2" data-testid="example-needs">
              <IconCheck size={14} className="me-1" />
              Nothing: it works as it is.
            </div>
          ) : (
            <ul className="list-unstyled small mb-2" data-testid="example-needs">
              {example.needs.map((need) => {
                // Entities are added after installing; the rest may be set up already.
                const met = setup !== null && need.kind !== "entities" && needMet(need, setup);
                // Set up, but refused the last time (a password Gmail no longer takes).
                const failing = need.kind === "email" ? setup?.emailProblem : null;
                return (
                  <li key={need.label} className="d-flex align-items-center gap-1 flex-wrap" data-met={met}>
                    {met ? (
                      <IconCheck size={14} className="text-success" />
                    ) : (
                      <IconX size={14} className={failing ? "text-danger" : "text-secondary"} />
                    )}
                    {need.label}
                    {met && <span className="text-success">(set up)</span>}
                    {failing && (
                      <span className="text-danger" data-testid="example-need-problem" title={failing}>
                        (set up, but the last mail read failed: check the password on Credentials)
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="small text-secondary">
            {example.pipelines.length === 1 ? "Its pipeline: " : "Its pipelines: "}
            {example.pipelines.map((p) => p.name).join(", ")}
          </div>
          {map && (
            <div className="mt-3">
              <AppMap appId="" map={map} preview />
            </div>
          )}
        </div>
        <div className="card-footer d-flex gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setShowMap(!showMap)} data-testid="example-map">
            <IconMap size={16} className="me-1" />
            {showMap ? "Hide its map" : "See its map"}
          </button>
          {installed && (
            <Link to={`/apps/${installed.appId}`} className="btn btn-primary btn-sm ms-auto" data-testid="example-open">
              Open {installed.name}
            </Link>
          )}
          <button
            type="button"
            className={`btn btn-sm ${installed ? "" : "btn-primary ms-auto"}`}
            disabled={busy}
            onClick={onInstall}
            title={installed ? `You have ${installed.name}: this installs a second one, under names of its own` : undefined}
            data-testid="example-install"
          >
            <IconDownload size={16} className="me-1" />
            {installed ? "Install a copy" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}
