import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage } from "../lib/api";
import { api } from "../lib/endpoints";
import { useAction } from "../lib/use-load";
import { Modal } from "./ui";

/**
 * An App page's buttons (M32): each starts its pipeline (asking first when it says `confirm`) and opens the run. A list's
 * have no key; an entity's pass it, and only those whose `when` holds are shown.
 */
export function EntityButtons({
  appId,
  type,
  entityKey,
  actions,
}: {
  appId: string;
  type: string;
  entityKey?: string;
  actions: { index: number; label: string; confirm?: string }[];
}) {
  const navigate = useNavigate();
  const action = useAction();
  const [asking, setAsking] = useState<(typeof actions)[number] | null>(null);
  const start = async (index: number) => {
    setAsking(null);
    const run = await action.run(
      () => api.apps.act(appId, type, index, entityKey),
      (error) => toast.error(errorMessage(error)),
    );
    if (run) void navigate(`/runs/${run.runId}`);
  };
  return (
    <>
      {actions.map((a) => (
        <button
          key={a.index}
          type="button"
          className="btn"
          disabled={action.busy}
          onClick={() => (a.confirm ? setAsking(a) : void start(a.index))}
          data-testid="entity-action"
        >
          {a.label}
        </button>
      ))}
      {asking && (
        <Modal
          title={asking.label}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void start(asking.index)}>
                {asking.label}
              </button>
            </>
          }
        >
          {asking.confirm}
        </Modal>
      )}
    </>
  );
}
