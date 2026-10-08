// Session: who is signed in (/api/me) and role helpers.
import { createContext, type ReactNode, useContext } from "react";
import type { MeDto } from "../../shared/api.ts";
import type { Role } from "../../shared/roles.ts";
import { useMe } from "../api/queries.ts";

type Session = { me: MeDto | null; loading: boolean; error: unknown };
const SessionContext = createContext<Session>({ me: null, loading: true, error: null });

export function SessionProvider({ children }: { children: ReactNode }) {
  const q = useMe();
  return <SessionContext.Provider value={{ me: q.data ?? null, loading: q.isLoading, error: q.error }}>{children}</SessionContext.Provider>;
}

/** Test seam: provide a fixed session without fetching. */
export function StaticSession({ me, children }: { me: MeDto | null; children: ReactNode }) {
  return <SessionContext.Provider value={{ me, loading: false, error: null }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

export function hasRole(me: MeDto | null, ...roles: Role[]): boolean {
  return !!me && roles.includes(me.role);
}

export function homeFor(me: MeDto): string {
  switch (me.role) {
    case "employee":
      return "/me";
    case "manager":
      return "/approvals";
    case "coordinator":
      return "/queue";
    case "admin":
      return "/dashboard";
  }
}
