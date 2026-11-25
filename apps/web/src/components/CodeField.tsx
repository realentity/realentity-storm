import { IconCopy } from "@tabler/icons-react";
import { toast } from "react-toastify";

/** M62/M63: the authenticator code, asked again for a change that decides where your data goes. */
export function CodeField({ value, onChange, hint, testId }: { value: string; onChange: (value: string) => void; hint: string; testId: string }) {
  return (
    <label className="form-label">
      Code from your authenticator app
      <input
        className="form-control"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        data-testid={testId}
      />
      <span className="form-hint">{hint}</span>
    </label>
  );
}

export function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" className="btn btn-icon btn-sm" title="Copy" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}>
      <IconCopy size={14} />
    </button>
  );
}
