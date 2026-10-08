// Typed operations against the simulated HR system.
import { z } from "zod";
import { simIdempotencyKey } from "../../shared/ids.ts";
import type { EmployeeProfile } from "../db/repo.ts";
import type { CallResult, IntegrationClient } from "./client.ts";

export const Worker = z.object({ id: z.string(), status: z.string() });
export const DocumentVerification = z.object({ id: z.string(), status: z.enum(["pending", "verified"]) });
export const Enrollment = z.object({ id: z.string(), sessionDate: z.string() });
export const Activation = z.object({ status: z.literal("active") });
export const WorkerRecord = z.object({ id: z.string(), status: z.string(), employeeRef: z.string() });

export const PAPERWORK_DOCUMENTS = ["offer_docs", "i9_section1", "w4", "direct_deposit"] as const;

export function createWorker(c: IntegrationClient, e: EmployeeProfile): Promise<CallResult<z.infer<typeof Worker>>> {
  return c.call({
    operation: "hr.create-worker",
    path: "/v1/workers",
    idempotencyKey: simIdempotencyKey(e.id, "hr.create-worker"),
    body: {
      employeeRef: e.id,
      legalName: `${e.firstName} ${e.lastName}`,
      email: e.email,
      startDate: e.startDate,
      costCenter: e.costCenter,
      orgUnit: e.orgUnit,
      employmentType: e.employmentType,
    },
    schema: Worker,
  });
}

export function startDocumentVerification(c: IntegrationClient, employeeId: string, workerId: string) {
  return c.call({
    operation: "hr.start-document-verification",
    path: `/v1/workers/${workerId}/document-verifications`,
    idempotencyKey: simIdempotencyKey(employeeId, "hr.start-document-verification"),
    body: { documents: [...PAPERWORK_DOCUMENTS] },
    schema: DocumentVerification,
  });
}

export function getDocumentVerification(c: IntegrationClient, id: string) {
  return c.call({ operation: "hr.get-document-verification", path: `/v1/document-verifications/${id}`, schema: DocumentVerification });
}

export function enrollOrientation(c: IntegrationClient, employeeId: string, workerId: string, sessionDate: string) {
  return c.call({
    operation: "hr.enroll-orientation",
    path: "/v1/orientation-enrollments",
    idempotencyKey: simIdempotencyKey(employeeId, "hr.enroll-orientation"),
    body: { workerId, sessionDate },
    schema: Enrollment,
  });
}

export function activateWorker(c: IntegrationClient, employeeId: string, workerId: string) {
  return c.call({
    operation: "hr.activate-worker",
    path: `/v1/workers/${workerId}/activation`,
    idempotencyKey: simIdempotencyKey(employeeId, "hr.activate-worker"),
    body: {},
    schema: Activation,
  });
}

export function getWorker(c: IntegrationClient, workerId: string) {
  return c.call({ operation: "hr.get-worker", path: `/v1/workers/${workerId}`, schema: WorkerRecord });
}
