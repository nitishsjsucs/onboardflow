// Simulated IT system (identity, licensing, device ordering stand-in). Not a real integration.
import { z } from "zod";
import { ALLOWED_BUNDLES, EQUIPMENT_PROFILES, LICENSE_BUNDLES, type EmploymentType, type LicenseBundle } from "../../shared/domain.ts";
import { type AnyOp, type GetOp, type PostOp, simError, type SimCtx } from "./pipeline.ts";
import { findByEmployee, insertResource, loadResource, newResourceId } from "./resources.ts";

export const CreateAccountBody = z.object({ employeeRef: z.string().min(1), upn: z.string().min(3), displayName: z.string().min(1) });
const createAccount: PostOp<z.infer<typeof CreateAccountBody>> = {
  method: "POST",
  system: "it",
  operation: "create-account",
  path: "/it/v1/accounts",
  schema: CreateAccountBody,
  employeeRef: async (_ctx, b) => b.employeeRef,
  validate: async () => null,
  execute: async (ctx, b) => {
    const id = newResourceId("acct");
    return {
      status: 201,
      body: { id, upn: b.upn, status: "active" },
      resourceId: id,
      employeeRef: b.employeeRef,
      statements: [insertResource(ctx.db, { system: "it", id, type: "it_account", employeeRef: b.employeeRef, status: "active", data: b, now: ctx.now })],
    };
  },
};

async function account(ctx: SimCtx, id: string | undefined) {
  if (!id) return null;
  const a = await loadResource(ctx.db, "it", id);
  return a && a.resource_type === "it_account" ? a : null;
}

const BUNDLE_CONTENTS: Record<LicenseBundle, string[]> = {
  "ft-standard": ["office-suite", "sso", "chat"],
  "ft-engineering": ["office-suite", "sso", "chat", "source-control", "cloud-console"],
  "contractor-basic": ["sso", "chat"],
  "intern-basic": ["office-suite", "sso", "chat"],
};

export const LicensesBody = z.object({
  bundle: z.enum(LICENSE_BUNDLES),
  privileged: z.boolean(),
  /** Approval that granted privileged access; required when privileged is true. */
  approvalRef: z.string().optional(),
});
const assignLicenses: PostOp<z.infer<typeof LicensesBody>> = {
  method: "POST",
  system: "it",
  operation: "assign-licenses",
  path: "/it/v1/accounts/:id/licenses",
  schema: LicensesBody,
  employeeRef: async (ctx) => (await account(ctx, ctx.params.id))?.employee_ref ?? null,
  validate: async (ctx, b) => {
    const a = await account(ctx, ctx.params.id);
    if (!a) return simError(404, "account_not_found", "unknown account");
    // IT reads the employment type from the HR system of record.
    const worker = await findByEmployee(ctx.db, "hr", "hr_worker", a.employee_ref);
    if (!worker) return simError(422, "validation_failed", "no HR worker for this account", { field: "employeeRef" });
    const type = (JSON.parse(worker.data_json) as { employmentType: EmploymentType }).employmentType;
    if (!ALLOWED_BUNDLES[type].includes(b.bundle)) {
      return simError(422, "validation_failed", `bundle ${b.bundle} is not allowed for ${type}`, { field: "licenseBundle" });
    }
    if (b.privileged && !b.approvalRef) {
      return simError(422, "validation_failed", "privileged access needs an approval reference", { field: "privileged" });
    }
    return null;
  },
  execute: async (ctx, b) => {
    const a = (await account(ctx, ctx.params.id))!;
    const id = newResourceId("lic");
    const assigned = [...BUNDLE_CONTENTS[b.bundle], ...(b.privileged ? ["privileged-admin"] : [])];
    return {
      status: 201,
      body: { assigned },
      resourceId: id,
      employeeRef: a.employee_ref,
      statements: [
        insertResource(ctx.db, {
          system: "it",
          id,
          type: "it_licenses",
          employeeRef: a.employee_ref,
          status: "assigned",
          data: { accountId: a.id, ...b, assigned },
          now: ctx.now,
        }),
      ],
    };
  },
};

export const DeviceOrderBody = z.object({ accountId: z.string().min(1), profile: z.enum(EQUIPMENT_PROFILES), shipTo: z.string().min(1) });
const orderDevice: PostOp<z.infer<typeof DeviceOrderBody>> = {
  method: "POST",
  system: "it",
  operation: "order-device",
  path: "/it/v1/device-orders",
  schema: DeviceOrderBody,
  employeeRef: async (ctx, b) => (await account(ctx, b.accountId))?.employee_ref ?? null,
  validate: async (ctx, b) => ((await account(ctx, b.accountId)) ? null : simError(404, "account_not_found", "unknown account")),
  execute: async (ctx, b) => {
    const a = (await account(ctx, b.accountId))!;
    const id = newResourceId("dev");
    return {
      status: 202,
      body: { id, status: "ordered" },
      resourceId: id,
      employeeRef: a.employee_ref,
      statements: [insertResource(ctx.db, { system: "it", id, type: "it_device", employeeRef: a.employee_ref, status: "ordered", data: b, now: ctx.now })],
    };
  },
};

const getDeviceOrder: GetOp = {
  method: "GET",
  system: "it",
  operation: "get-device-order",
  path: "/it/v1/device-orders/:id",
  resourceTypes: ["it_device"],
  respond: (_ctx, row) => ({ status: 200, body: { id: row.id, status: row.status } }),
};

const getAccount: GetOp = {
  method: "GET",
  system: "it",
  operation: "get-account",
  path: "/it/v1/accounts/:id",
  resourceTypes: ["it_account"],
  respond: async (ctx, row) => {
    const lic = await ctx.db
      .prepare("SELECT data_json FROM sim_resources WHERE system = 'it' AND resource_type = 'it_licenses' AND json_extract(data_json, '$.accountId') = ?")
      .bind(row.id)
      .all<{ data_json: string }>();
    const licenses = [...new Set(lic.results.flatMap((r) => (JSON.parse(r.data_json) as { assigned: string[] }).assigned))].sort();
    const d = JSON.parse(row.data_json) as { upn: string };
    return { status: 200, body: { id: row.id, upn: d.upn, status: row.status, employeeRef: row.employee_ref, licenses } };
  },
};

export const IT_OPS: AnyOp[] = [createAccount, assignLicenses, orderDevice, getDeviceOrder, getAccount];
