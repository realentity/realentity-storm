import { IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "react-toastify";
import { errorMessage } from "../lib/api";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { Modal } from "./ui";

/**
 * Always in the top bar (README §2.6). Engaging stops queued and waiting runs, expires their proposals and makes
 * running ones stop at their next step; releasing lets schedules start runs again (stopped runs stay stopped).
 */
export function KillSwitchButton() {
  const state = useLoad(
    () => api.killSwitch.get(),
    [],
    (signal) => signal.type === "killSwitch",
  );
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const engaged = state.data?.engaged ?? false;

  const set = async (value: boolean) => {
    const view = await action.run(
      () => api.killSwitch.set(value),
      (error) => toast.error(`Kill switch: ${errorMessage(error)}`),
    );
    setConfirming(false);
    if (!view) return;
    state.reload();
    toast[value ? "warning" : "success"](
      value ? `Everything is paused${view.stoppedRuns ? `; ${view.stoppedRuns} run(s) stopped` : ""}` : "Pipelines can run again",
    );
  };

  return (
    <>
      {engaged ? (
        <button type="button" className="btn btn-success" disabled={action.busy} onClick={() => void set(false)} data-testid="kill-switch">
          <IconPlayerPlay size={18} className="me-1" />
          Paused · resume
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-danger"
          disabled={action.busy || state.loading}
          onClick={() => setConfirming(true)}
          data-testid="kill-switch"
        >
          <IconPlayerStop size={18} className="me-1" />
          Stop everything
        </button>
      )}
      {confirming && (
        <Modal
          title="Stop everything?"
          size="sm"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={action.busy}
                onClick={() => void set(true)}
                data-testid="kill-switch-confirm"
              >
                Stop everything
              </button>
            </>
          }
        >
          Queued and waiting runs stop and their proposals expire, so nothing approved can act. Running runs stop at their next step.
          Schedules keep firing but start nothing until I resume.
        </Modal>
      )}
    </>
  );
}
