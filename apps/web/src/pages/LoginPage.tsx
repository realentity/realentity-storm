import { useState, type FormEvent } from "react";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { useSession } from "../context/use-session";
import { ApiError, errorMessage } from "../lib/api";

/** Password + TOTP (docs/design.md §16). Errors don't say which of the two was wrong. */
export function LoginPage() {
  const { login } = useSession();
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login({ password, totp });
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 429 ? "Too many attempts; wait a minute" : errorMessage(reason));
      setTotp("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-center">
      <div className="position-absolute top-0 end-0 p-3">
        <ThemeSwitch />
      </div>
      <div className="container container-tight py-4">
        <div className="text-center mb-4 d-flex flex-column align-items-center gap-2">
          <img src="/logo.svg" alt="" width={56} height={56} />
          <div className="fs-1 fw-bold">RealEntity Storm</div>
        </div>
        <form className="card card-md" onSubmit={(e) => void submit(e)} autoComplete="off">
          <div className="card-body">
            <h2 className="h2 text-center mb-4">Sign in</h2>
            {error && (
              <div className="alert alert-danger" role="alert">
                {error}
              </div>
            )}
            <div className="mb-3">
              <label className="form-label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="form-control"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="mb-3">
              <label className="form-label" htmlFor="totp">
                Authenticator code
              </label>
              <input
                id="totp"
                className="form-control"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary w-100" disabled={busy}>
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
