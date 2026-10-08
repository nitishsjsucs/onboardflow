// Typed operations against the simulated Facilities system.
import { z } from "zod";
import { simIdempotencyKey } from "../../shared/ids.ts";
import type { EmployeeProfile } from "../db/repo.ts";
import type { IntegrationClient } from "./client.ts";
import { ConflictError } from "./errors.ts";

export const WORKSPACE_PREFERENCES = ["team-neighborhood", "quiet-zone", "any-available"] as const;
export const Workspace = z.object({ id: z.string(), kind: z.enum(["desk", "remote_kit"]), deskId: z.string().optional() });
export const Badge = z.object({ id: z.string(), status: z.enum(["requested", "printed", "active"]) });

/**
 * Assigns a workspace. A 409 desk conflict is handled inside the step: the
 * next site preference is tried, up to 3 preferences in total (SPEC 8.3).
 */
export async function assignWorkspace(c: IntegrationClient, e: EmployeeProfile) {
  let last: unknown = null;
  for (let i = 0; i < WORKSPACE_PREFERENCES.length; i++) {
    try {
      const r = await c.call({
        operation: "facilities.assign-workspace",
        path: "/v1/workspace-assignments",
        idempotencyKey: simIdempotencyKey(e.id, "facilities.assign-workspace"),
        body: { employeeRef: e.id, workMode: e.workMode, site: e.site, preference: WORKSPACE_PREFERENCES[i] },
        schema: Workspace,
        subAttempt: i + 1,
      });
      return { ...r, preference: WORKSPACE_PREFERENCES[i] as string, preferencesTried: i + 1 };
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      last = err;
    }
  }
  throw last;
}

export function issueBadge(c: IntegrationClient, e: EmployeeProfile) {
  return c.call({
    operation: "facilities.issue-badge",
    path: "/v1/badges",
    idempotencyKey: simIdempotencyKey(e.id, "facilities.issue-badge"),
    body: { employeeRef: e.id, photoOnFile: e.photoOnFile, accessLevel: e.needsPrivilegedAccess ? "restricted" : "standard" },
    schema: Badge,
  });
}

export function getBadge(c: IntegrationClient, id: string) {
  return c.call({ operation: "facilities.get-badge", path: `/v1/badges/${id}`, schema: Badge });
}
