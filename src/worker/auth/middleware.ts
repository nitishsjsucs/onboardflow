// Request authentication: Access JWT -> verified email -> principal from
// app_users. Unknown or inactive emails get 403 not_provisioned and an
// auth.denied audit row; missing or invalid tokens get 401.
import type { MiddlewareHandler } from "hono";
import { isDepartment, isRole, type Role } from "../../shared/roles.ts";
import { auditIds } from "../../shared/ids.ts";
import { auditInsert } from "../db/audit.ts";
import { apiError, type AppEnv, type Principal } from "../http.ts";
import { AccessTokenError, readAccessToken, verifyAccessJwt } from "./access.ts";
import { keySourceFor } from "./key-source.ts";

type PrincipalRow = {
  email: string;
  role: string;
  employee_id: string | null;
  staff_id: string | null;
  emp_name: string | null;
  staff_name: string | null;
  department: string | null;
};

export async function loadPrincipal(db: D1Database, email: string): Promise<Principal | null> {
  const row = await db
    .prepare(
      `SELECT u.email, u.role, u.employee_id, u.staff_id,
              e.first_name || ' ' || e.last_name AS emp_name, s.display_name AS staff_name, s.department
         FROM app_users u
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN staff s ON s.id = u.staff_id
        WHERE u.email = ? AND u.active = 1`,
    )
    .bind(email)
    .first<PrincipalRow>();
  if (!row || !isRole(row.role)) return null;
  const p: Principal = { email: row.email, role: row.role, displayName: row.emp_name ?? row.staff_name ?? row.email };
  if (row.employee_id) p.employeeId = row.employee_id;
  if (row.staff_id) p.staffId = row.staff_id;
  if (row.role === "coordinator" && isDepartment(row.department)) p.department = row.department;
  return p;
}

/** Authenticates the request and sets `principal`. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readAccessToken(c.req.raw);
  if (!token) return apiError(c, 401, "unauthenticated", "Access token missing");
  const source = keySourceFor(c.get("config"));
  let email: string;
  try {
    ({ email } = await verifyAccessJwt(token, source.getKey, source));
  } catch (err) {
    const message = err instanceof AccessTokenError ? err.message : "token verification failed";
    return apiError(c, 401, "unauthenticated", message);
  }
  const principal = await loadPrincipal(c.env.DB, email);
  if (!principal) {
    const requestId = c.get("requestId");
    await auditInsert(c.env.DB, {
      id: auditIds.user(requestId, "auth.denied"),
      occurredAt: c.get("clock").nowIso(),
      actorType: "user",
      actorId: email,
      action: "auth.denied",
      entityType: "app_user",
      entityId: email,
      requestId,
      detail: { path: new URL(c.req.url).pathname, reason: "not_provisioned" },
    }).run();
    return apiError(c, 403, "not_provisioned", "this email has no OnboardFlow account");
  }
  c.set("principal", principal);
  return next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.get("principal");
    if (!roles.includes(p.role)) return apiError(c, 403, "forbidden", `requires role ${roles.join(" or ")}`);
    return next();
  };
}
