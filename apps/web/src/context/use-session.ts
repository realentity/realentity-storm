import { type LoginRequest, type SessionView } from "@realentity/storm-shared";
import { createContext, useContext } from "react";

export interface SessionState {
  /** undefined while checking, null when signed out. */
  session: SessionView | null | undefined;
  login: (body: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
