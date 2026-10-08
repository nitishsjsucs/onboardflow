import type { ReactNode } from "react";
import type { Role } from "../../shared/roles.ts";
import { hasRole, useSession } from "../auth/session.tsx";

/** Renders children only for the given roles. The server enforces the same policy. */
export function RoleGate({ roles, children, fallback }: { roles: Role[]; children: ReactNode; fallback?: ReactNode }) {
  const { me } = useSession();
  if (!hasRole(me, ...roles)) return <>{fallback ?? <p className="muted">This page is not available for your role.</p>}</>;
  return <>{children}</>;
}
