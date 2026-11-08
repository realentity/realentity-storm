import { IconTrash } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { useAction } from "../lib/use-load";
import { ErrorAlert, Modal } from "./ui";

/**
 * Delete an App or a pipeline, after saying what goes with it. A refusal (a run still going, pipelines that still
 * belong to the App) is shown in the dialog, as the API says it.
 */
export function DeleteButton({
  what,
  name,
  consequences,
  onDelete,
  then,
}: Readonly<{
  what: "App" | "pipeline";
  name: string;
  /** What goes with it, in a sentence or two. */
  consequences: ReactNode;
  onDelete: () => Promise<void>;
  /** Where to go after. */
  then: string;
}>) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  const navigate = useNavigate();
  const remove = async () => {
    const done = await action.run(async () => {
      await onDelete();
      return true;
    });
    if (!done) return;
    toast.success(`Deleted ${name}`);
    void navigate(then);
  };
  return (
    <>
      <button type="button" className="btn btn-ghost-danger" onClick={() => setOpen(true)} data-testid={`delete-${what.toLowerCase()}`}>
        <IconTrash size={18} className="me-1" />
        Delete
      </button>
      {open && (
        <Modal
          title={`Delete ${name}?`}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Keep it
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={action.busy}
                onClick={() => void remove()}
                data-testid="confirm-delete"
              >
                <IconTrash size={18} className="me-1" />
                Delete the {what}
              </button>
            </>
          }
        >
          <p className="mb-2">{consequences}</p>
          <p className="text-secondary mb-0">This can&apos;t be undone.</p>
          <div className="mt-3">
            <ErrorAlert error={action.error} />
          </div>
        </Modal>
      )}
    </>
  );
}
