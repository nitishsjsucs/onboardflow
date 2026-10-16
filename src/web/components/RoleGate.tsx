import type { ReactNode } from "react";
import type { MeDto } from "../../shared/api.ts";
import type { Role } from "../../shared/roles.ts";
import { hasRole, useSession } from "../auth/session.tsx";

/**
 * Renders children only for the given roles (and, with `allow`, only for the principals it accepts,
 * for example People Ops among coordinators). The server enforces the same policy.
 */
export function RoleGate({ roles, allow, children, fallback }: { roles: Role[]; allow?: (me: MeDto) => boolean; children: ReactNode; fallback?: ReactNode }) {
  const { me } = useSession();
  if (!hasRole(me, ...roles) || (allow && me && !allow(me))) return <>{fallback ?? <p className="muted">This page is not available for your role.</p>}</>;
  return <>{children}</>;
}
