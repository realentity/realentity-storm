import { type BuilderBrief } from "@realentity/storm-shared";
import { IconClipboardText } from "@tabler/icons-react";

/**
 * M70-T2: what the builder says it will make, before it proposes a new idea: the App and its types, each pipeline (what
 * starts it, what it does, what waits for me, what it sends), what I set up after, and what Storm can't do of what I
 * asked. I agree or change it in my answer; it stays in the chat as what was agreed.
 */
export function BriefCard({ brief }: Readonly<{ brief: BuilderBrief }>) {
  return (
    <div className="card" data-testid="builder-brief">
      <div className="card-header">
        <h3 className="card-title d-flex align-items-center gap-2">
          <IconClipboardText size={18} className="text-azure" />
          What I'll make
        </h3>
      </div>
      <div className="card-body d-flex flex-column gap-3">
        <div>{brief.summary}</div>
        {brief.app && (
          <div data-testid="brief-app">
            <div className="fw-bold mb-1">The App: {brief.app.name}</div>
            <ul className="mb-0 ps-3">
              {brief.app.types.map((type) => (
                <li key={type.name}>
                  <strong>{type.name}</strong>: {type.about}
                  {type.fields.length > 0 && <div className="small text-secondary">{type.fields.join("; ")}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {brief.pipelines.length > 0 && (
          <div data-testid="brief-pipelines">
            <div className="fw-bold mb-1">{brief.pipelines.length === 1 ? "Its pipeline" : "Its pipelines"}</div>
            <ul className="mb-0 ps-3">
              {brief.pipelines.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong> ({p.trigger}): {p.does}
                  {p.waitsForMe && <div className="small">Waits for you: {p.waitsForMe}</div>}
                  {p.sends && <div className="small">Sends: {p.sends}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {brief.setup.length > 0 && (
          <div data-testid="brief-setup">
            <div className="fw-bold mb-1">You set up after saving</div>
            <ul className="mb-0 ps-3">
              {brief.setup.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {brief.cannot.length > 0 && (
          <div className="alert alert-warning mb-0" data-testid="brief-cannot">
            <div className="fw-bold mb-1">What Storm can't do of this</div>
            <ul className="mb-0 ps-3">
              {brief.cannot.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="small text-secondary">Agree, or say what to change: I'll propose it after your answer.</div>
      </div>
    </div>
  );
}
