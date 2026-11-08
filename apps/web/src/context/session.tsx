import { type LoginRequest, type SessionView } from "@realentity/storm-shared";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, onUnauthorized } from "../lib/api";
import { api } from "../lib/endpoints";
import { events } from "../lib/events";
import { SessionContext } from "./use-session";

/** The signed-in session (cookie), and the live event socket while there is one. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null | undefined>(undefined);

  useEffect(() => {
    api.auth.session().then(setSession, (error: unknown) => {
      setSession(null);
      if (!(error instanceof ApiError && error.status === 401)) console.error(error);
    });
    return onUnauthorized(() => setSession(null));
  }, []);

  useEffect(() => {
    if (session) events.start();
    else events.stop();
  }, [session]);

  const login = useCallback(async (body: LoginRequest) => setSession(await api.auth.login(body)), []);
  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, login, logout }), [session, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
