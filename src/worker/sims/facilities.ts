// Simulated Facilities system (workspace and badge stand-in). Not a real integration.
import { z } from "zod";
import { WORK_MODES } from "../../shared/domain.ts";
import { type AnyOp, type GetOp, type PostOp, simError } from "./pipeline.ts";
import { insertResource, newResourceId } from "./resources.ts";

export const WORKSPACE_PREFERENCES = ["team-neighborhood", "quiet-zone", "any-available"] as const;

export const WorkspaceBody = z.object({
  employeeRef: z.string().min(1),
  workMode: z.enum(WORK_MODES),
  site: z.string().min(1),
  preference: z.enum(WORKSPACE_PREFERENCES),
});

const SITE_CODES: Record<string, string> = { "San Jose HQ": "SJ", Austin: "AUS", "New York": "NYC" };

const assignWorkspace: PostOp<z.infer<typeof WorkspaceBody>> = {
  method: "POST",
  system: "facilities",
  operation: "assign-workspace",
  path: "/facilities/v1/workspace-assignments",
  schema: WorkspaceBody,
  employeeRef: async (_ctx, b) => b.employeeRef,
  validate: async () => null,
  execute: async (ctx, b) => {
    const id = newResourceId("ws");
    const remote = b.workMode === "remote";
    const floor = WORKSPACE_PREFERENCES.indexOf(b.preference) + 2;
    const deskId = remote ? undefined : `${SITE_CODES[b.site] ?? "HQ"}-${floor}-${id.slice(-3).toUpperCase()}`;
    const body = remote ? { id, kind: "remote_kit" } : { id, kind: "desk", deskId };
    return {
      status: 201,
      body,
      resourceId: id,
      employeeRef: b.employeeRef,
      statements: [
        insertResource(ctx.db, { system: "facilities", id, type: "fac_workspace", employeeRef: b.employeeRef, status: "assigned", data: { ...b, ...body }, now: ctx.now }),
      ],
    };
  },
};

export const BadgeBody = z.object({
  employeeRef: z.string().min(1),
  photoOnFile: z.boolean(),
  accessLevel: z.enum(["standard", "restricted"]),
});
const issueBadge: PostOp<z.infer<typeof BadgeBody>> = {
  method: "POST",
  system: "facilities",
  operation: "issue-badge",
  path: "/facilities/v1/badges",
  schema: BadgeBody,
  employeeRef: async (_ctx, b) => b.employeeRef,
  validate: async (_ctx, b) =>
    b.photoOnFile ? null : simError(422, "validation_failed", "a badge photo is required", { field: "photoOnFile" }),
  execute: async (ctx, b) => {
    const id = newResourceId("bdg");
    return {
      status: 202,
      body: { id, status: "requested" },
      resourceId: id,
      employeeRef: b.employeeRef,
      statements: [insertResource(ctx.db, { system: "facilities", id, type: "fac_badge", employeeRef: b.employeeRef, status: "requested", data: b, now: ctx.now })],
    };
  },
};

const getBadge: GetOp = {
  method: "GET",
  system: "facilities",
  operation: "get-badge",
  path: "/facilities/v1/badges/:id",
  resourceTypes: ["fac_badge"],
  respond: (_ctx, row) => ({ status: 200, body: { id: row.id, status: row.status, employeeRef: row.employee_ref } }),
};

export const FACILITIES_OPS: AnyOp[] = [assignWorkspace, issueBadge, getBadge];
