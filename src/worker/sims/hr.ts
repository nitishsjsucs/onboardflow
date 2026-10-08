// Simulated HR system (HRIS stand-in). Not a real integration.
import { z } from "zod";
import { COST_CENTER_PATTERN, EMPLOYMENT_TYPES } from "../../shared/domain.ts";
import { type AnyOp, type GetOp, type PostOp, simError } from "./pipeline.ts";
import { findByEmployee, insertResource, loadResource, newResourceId } from "./resources.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateWorkerBody = z.object({
  employeeRef: z.string().min(1),
  legalName: z.string().min(1),
  email: z.string().min(3),
  startDate: isoDate,
  costCenter: z.string(),
  orgUnit: z.string().min(1),
  employmentType: z.enum(EMPLOYMENT_TYPES),
});
export type CreateWorkerBody = z.infer<typeof CreateWorkerBody>;

const createWorker: PostOp<CreateWorkerBody> = {
  method: "POST",
  system: "hr",
  operation: "create-worker",
  path: "/hr/v1/workers",
  schema: CreateWorkerBody,
  employeeRef: async (_ctx, b) => b.employeeRef,
  validate: async (_ctx, b) =>
    COST_CENTER_PATTERN.test(b.costCenter)
      ? null
      : simError(422, "validation_failed", "costCenter must match CC-####", { field: "costCenter" }),
  execute: async (ctx, b) => {
    const id = newResourceId("wkr");
    return {
      status: 201,
      body: { id, status: "preboarding" },
      resourceId: id,
      employeeRef: b.employeeRef,
      statements: [
        insertResource(ctx.db, { system: "hr", id, type: "hr_worker", employeeRef: b.employeeRef, status: "preboarding", data: b, now: ctx.now }),
      ],
    };
  },
};

async function workerRef(ctx: { db: D1Database }, id: string | undefined) {
  if (!id) return null;
  const w = await loadResource(ctx.db, "hr", id);
  return w && w.resource_type === "hr_worker" ? w : null;
}

export const DocumentVerificationBody = z.object({ documents: z.array(z.string()).min(1) });
const startDocumentVerification: PostOp<z.infer<typeof DocumentVerificationBody>> = {
  method: "POST",
  system: "hr",
  operation: "start-document-verification",
  path: "/hr/v1/workers/:id/document-verifications",
  schema: DocumentVerificationBody,
  employeeRef: async (ctx) => (await workerRef(ctx, ctx.params.id))?.employee_ref ?? null,
  validate: async (ctx) => ((await workerRef(ctx, ctx.params.id)) ? null : simError(404, "worker_not_found", "unknown worker")),
  execute: async (ctx, b) => {
    const worker = (await workerRef(ctx, ctx.params.id))!;
    const id = newResourceId("docv");
    return {
      status: 202,
      body: { id, status: "pending" },
      resourceId: id,
      employeeRef: worker.employee_ref,
      statements: [
        insertResource(ctx.db, {
          system: "hr",
          id,
          type: "hr_documents",
          employeeRef: worker.employee_ref,
          status: "pending",
          data: { workerId: worker.id, documents: b.documents },
          now: ctx.now,
        }),
      ],
    };
  },
};

const getDocumentVerification: GetOp = {
  method: "GET",
  system: "hr",
  operation: "get-document-verification",
  path: "/hr/v1/document-verifications/:id",
  resourceTypes: ["hr_documents"],
  respond: (_ctx, row) => ({ status: 200, body: { id: row.id, status: row.status } }),
};

export const OrientationBody = z.object({ workerId: z.string().min(1), sessionDate: isoDate });
const enrollOrientation: PostOp<z.infer<typeof OrientationBody>> = {
  method: "POST",
  system: "hr",
  operation: "enroll-orientation",
  path: "/hr/v1/orientation-enrollments",
  schema: OrientationBody,
  employeeRef: async (ctx, b) => (await workerRef(ctx, b.workerId))?.employee_ref ?? null,
  validate: async (ctx, b) => {
    const w = await workerRef(ctx, b.workerId);
    if (!w) return simError(404, "worker_not_found", "unknown worker");
    const start = (JSON.parse(w.data_json) as { startDate: string }).startDate;
    return b.sessionDate < start
      ? simError(422, "validation_failed", "orientation session is before the start date", { field: "sessionDate" })
      : null;
  },
  execute: async (ctx, b) => {
    const w = (await workerRef(ctx, b.workerId))!;
    const id = newResourceId("orn");
    return {
      status: 201,
      body: { id, sessionDate: b.sessionDate },
      resourceId: id,
      employeeRef: w.employee_ref,
      statements: [
        insertResource(ctx.db, { system: "hr", id, type: "hr_orientation", employeeRef: w.employee_ref, status: "enrolled", data: b, now: ctx.now }),
      ],
    };
  },
};

const activateWorker: PostOp<Record<string, never>> = {
  method: "POST",
  system: "hr",
  operation: "activate-worker",
  path: "/hr/v1/workers/:id/activation",
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  employeeRef: async (ctx) => (await workerRef(ctx, ctx.params.id))?.employee_ref ?? null,
  validate: async (ctx) => {
    const w = await workerRef(ctx, ctx.params.id);
    if (!w) return simError(404, "worker_not_found", "unknown worker");
    const docs = await findByEmployee(ctx.db, "hr", "hr_documents", w.employee_ref);
    return docs?.status === "verified" ? null : simError(409, "documents_not_verified", "documents are not verified");
  },
  execute: async (ctx) => {
    const w = (await workerRef(ctx, ctx.params.id))!;
    return {
      status: 200,
      body: { status: "active" },
      resourceId: w.id,
      employeeRef: w.employee_ref,
      statements: [
        ctx.db
          .prepare("UPDATE sim_resources SET status = 'active', updated_at = ? WHERE system = 'hr' AND id = ?")
          .bind(ctx.now, w.id),
      ],
    };
  },
};

const getWorker: GetOp = {
  method: "GET",
  system: "hr",
  operation: "get-worker",
  path: "/hr/v1/workers/:id",
  resourceTypes: ["hr_worker"],
  respond: (_ctx, row) => {
    const d = JSON.parse(row.data_json) as CreateWorkerBody;
    return {
      status: 200,
      body: { id: row.id, status: row.status, employeeRef: row.employee_ref, startDate: d.startDate, employmentType: d.employmentType },
    };
  },
};

export const HR_OPS: AnyOp[] = [createWorker, startDocumentVerification, getDocumentVerification, enrollOrientation, activateWorker, getWorker];
