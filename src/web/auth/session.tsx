// Session: who is signed in (/api/me), whether the session ended since, and role helpers.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { MeDto } from "../../shared/api.ts";
import type { Role } from "../../shared/roles.ts";
import { ApiError, apiFetch } from "../api/client.ts";
import { keys, useMe } from "../api/queries.ts";

/**
 * `expired`: a request answered 401 after sign-in (the cookie or Access session ran out).
 * `refetch` asks /api/me again (Try again after it failed); `fetching` is true while it runs.
 */
type Session = { me: MeDto | null; loading: boolean; error: unknown; expired: boolean; refetch: () => unknown; fetching: boolean };
const noop = () => undefined;
const SessionContext = createContext<Session>({ me: null, loading: true, error: null, expired: false, refetch: noop, fetching: false });

function isUnauthenticated(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

/**
 * Whether a failed /api/me means nobody usable is signed in (go to the login page): a 401, or an Access
 * account with no OnboardFlow user. Anything else (a 5xx, a network failure) says nothing about the
 * session, so the page explains it and offers Try again instead of sending a signed-in user to sign in.
 */
export function isSignedOut(e: unknown): boolean {
  return isUnauthenticated(e) || (e instanceof ApiError && e.code === "not_provisioned");
}

function isMeKey(key: readonly unknown[]): boolean {
  return key.length === 1 && key[0] === keys.me[0];
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const q = useMe();
  const qc = useQueryClient();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    // Any query or mutation that answers 401 while someone is signed in means the session ended.
    const signedIn = () => !!qc.getQueryData<MeDto | null>(keys.me);
    const offQueries = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type === "error" && isUnauthenticated(event.action.error) && signedIn()) setExpired(true);
      if (event.action.type === "success" && isMeKey(event.query.queryKey) && event.action.data) setExpired(false);
    });
    const offMutations = qc.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error" && isUnauthenticated(event.action.error) && signedIn()) setExpired(true);
    });
    return () => {
      offQueries();
      offMutations();
    };
  }, [qc]);
  return (
    <SessionContext.Provider value={{ me: q.data ?? null, loading: q.isLoading, error: q.error, expired, refetch: q.refetch, fetching: q.isFetching }}>{children}</SessionContext.Provider>
  );
}

/** Test seam: provide a fixed session without fetching. */
export function StaticSession({ me, expired = false, children }: { me: MeDto | null; expired?: boolean; children: ReactNode }) {
  return <SessionContext.Provider value={{ me, loading: false, error: null, expired, refetch: noop, fetching: false }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

/** GET /api/health once per page load: which sign-in the deployment uses ("access" or "dev"). */
export function useAuthMode(): "access" | "dev" | null {
  const q = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => apiFetch<{ authMode: "access" | "dev" }>("/api/health", { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return q.data?.authMode ?? null;
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

/** Client mirror of the server policy (display only; the API enforces it). */
export const can = {
  retry: (me: MeDto | null, owner: string) => !!me && (me.role === "admin" || (me.role === "coordinator" && me.department === owner)),
  resubmit: (me: MeDto | null) => !!me && (me.role === "admin" || (me.role === "coordinator" && me.department === "people_ops")),
  workDepartment: (me: MeDto | null, owner: string) => !!me && (me.role === "admin" || (me.role === "coordinator" && me.department === owner)),
  startCase: (me: MeDto | null) => !!me && (me.role === "admin" || (me.role === "coordinator" && me.department === "people_ops")),
  restartOrTerminate: (me: MeDto | null) => me?.role === "admin",
  fixField: (me: MeDto | null, field: "costCenter" | "licenseBundle" | "photoOnFile") =>
    !!me && (me.role === "admin" || (me.role === "coordinator" && me.department === { costCenter: "people_ops", licenseBundle: "it", photoOnFile: "facilities" }[field])),
};
