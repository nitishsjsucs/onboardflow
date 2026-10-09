// Typed operations against the simulated Facilities system.
import { z } from "zod";
import { simIdempotencyKey } from "../../shared/ids.ts";
import type { EmployeeProfile } from "../db/repo.ts";
import type { IntegrationClient } from "./client.ts";
import { ConflictError, errorMessage } from "./errors.ts";

export const WORKSPACE_PREFERENCES = ["team-neighborhood", "quiet-zone", "any-available"] as const;
export const Workspace = z.object({ id: z.string(), kind: z.enum(["desk", "remote_kit"]), deskId: z.string().optional() });
export const Badge = z.object({ id: z.string(), status: z.enum(["requested", "printed", "active"]) });

/** Preference order for one execution: a preference stored by an earlier execution goes first. */
export function preferenceOrder(startWith?: string | null): string[] {
  const all: string[] = [...WORKSPACE_PREFERENCES];
  if (!startWith || !all.includes(startWith)) return all;
  return [startWith, ...all.filter((p) => p !== startWith)];
}

/** The simulator already stored this key with a different request. */
function isKeyReuse(err: unknown): boolean {
  return /http=422: idempotency_key_reuse/.test(errorMessage(err));
}

/**
 * Assigns a workspace. A 409 desk conflict is handled inside the step: the
 * next site preference is tried, up to 3 preferences in total (SPEC 8.3).
 *
 * All preferences share one Idempotency-Key, so once a desk conflict moved an
 * execution to a later preference, the simulator holds that preference under
 * the key. A re-execution (a restart, the new-revision fallback, or a step
 * retry after a lost response) must replay it rather than send preference 1
 * again: it starts from the preference recorded by an earlier execution
 * (`startWith`), and a 422 `idempotency_key_reuse` moves on to the next
 * preference, whose request then matches the stored one and replays.
 */
export async function assignWorkspace(c: IntegrationClient, e: EmployeeProfile, opts: { startWith?: string | null } = {}) {
  const order = preferenceOrder(opts.startWith);
  let last: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const preference = order[i]!;
    try {
      const r = await c.call({
        operation: "facilities.assign-workspace",
        path: "/v1/workspace-assignments",
        idempotencyKey: simIdempotencyKey(e.id, "facilities.assign-workspace"),
        body: { employeeRef: e.id, workMode: e.workMode, site: e.site, preference },
        schema: Workspace,
        subAttempt: i + 1,
      });
      return { ...r, preference, preferencesTried: i + 1 };
    } catch (err) {
      if (!(err instanceof ConflictError) && !isKeyReuse(err)) throw err;
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
