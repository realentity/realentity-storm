import { type WebhookView } from "@realentity/storm-shared";
import { IconCopy, IconKey, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "react-toastify";
import { errorMessage } from "../lib/api";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Modal } from "./ui";

/**
 * A pipeline's webhook (M12-T2): its address, a new secret (shown once, right here), removing it. Calls go to
 * hooks.example.com, which the VPS forwards to Storm's hooks-only site.
 */
export function WebhookCard({ pipelineId, auth }: { pipelineId: string; auth: "hmac-sha256" | "token" }) {
  const hook = useLoad(() => api.pipelines.webhook(pipelineId), [pipelineId]);
  const [fresh, setFresh] = useState<WebhookView | null>(null);
  const [removing, setRemoving] = useState(false);
  const action = useAction();
  const webhook = hook.data?.webhook ?? null;

  const rotate = async () => {
    const created = await action.run(() => api.pipelines.rotateWebhook(pipelineId), (error) => toast.error(errorMessage(error)));
    if (created) {
      setFresh(created);
      hook.reload();
    }
  };

  const remove = async () => {
    const done = await action.run(() => api.pipelines.removeWebhook(pipelineId).then(() => true), (error) => toast.error(errorMessage(error)));
    setRemoving(false);
    if (done) {
      setFresh(null);
      hook.reload();
    }
  };

  const address = webhook ? (webhook.url ?? webhook.path) : null;

  return (
    <div className="card" data-testid="webhook">
      <div className="card-header">
        <h3 className="card-title">Webhook</h3>
      </div>
      <div className="card-body d-flex flex-column gap-2">
        <ErrorAlert error={hook.error} />
        {webhook ? (
          <>
            <div>
              <div className="small text-secondary">POST to</div>
              <div className="d-flex gap-1 align-items-start">
                <code className="text-break flex-fill" data-testid="webhook-address">
                  {address}
                </code>
                <Copy text={address!} />
              </div>
              {!webhook.url && <div className="small text-secondary">Set HOOKS_PUBLIC_URL for the full public address.</div>}
            </div>
            <div className="small text-secondary">
              {auth === "token" ? "With Authorization: Bearer <secret>." : "Signed: X-Hub-Signature-256 (as GitHub sends it), with the secret."}{" "}
              {webhook.lastCalledAt ? `Last call ${formatDateTime(webhook.lastCalledAt)}.` : "Not called yet."}
            </div>
          </>
        ) : (
          <div className="small text-secondary">No address yet: the pipeline's trigger is a webhook, but nothing can call it until it has one.</div>
        )}
        {fresh?.secret && (
          <div className="alert alert-warning mb-0" data-testid="webhook-secret">
            <div className="mb-1">The secret, shown only now. Put it where the call comes from (GitHub's webhook secret, a script):</div>
            <div className="d-flex gap-1 align-items-start">
              <code className="text-break flex-fill">{fresh.secret}</code>
              <Copy text={fresh.secret} />
            </div>
          </div>
        )}
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void rotate()} data-testid="webhook-rotate">
            <IconKey size={16} className="me-1" />
            {webhook ? "New secret" : "Create the address"}
          </button>
          {webhook && (
            <button type="button" className="btn btn-sm btn-outline-danger" disabled={action.busy} onClick={() => setRemoving(true)}>
              <IconTrash size={16} className="me-1" />
              Remove
            </button>
          )}
        </div>
      </div>
      {removing && (
        <Modal
          title="Remove the webhook?"
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => void remove()}>
                Remove
              </button>
            </>
          }
        >
          <p>Calls to its address get 404 from now on. A new one gets a new address.</p>
        </Modal>
      )}
    </div>
  );
}

function Copy({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="btn btn-icon btn-sm"
      title="Copy"
      onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}
    >
      <IconCopy size={14} />
    </button>
  );
}
