// Typed operations against the simulated IT system.
import { z } from "zod";
import { simIdempotencyKey } from "../../shared/ids.ts";
import type { EmployeeProfile } from "../db/repo.ts";
import type { IntegrationClient } from "./client.ts";

export const Account = z.object({ id: z.string(), upn: z.string(), status: z.string() });
export const Licenses = z.object({ assigned: z.array(z.string()) });
export const DeviceOrder = z.object({ id: z.string(), status: z.enum(["ordered", "processing", "shipped", "delivered"]) });
export const AccountRecord = z.object({ id: z.string(), status: z.string(), licenses: z.array(z.string()) });

export function upnFor(e: EmployeeProfile): string {
  return `${e.firstName}.${e.lastName}.${e.id}@corp.onboardflow.test`.toLowerCase();
}

export function createAccount(c: IntegrationClient, e: EmployeeProfile) {
  return c.call({
    operation: "it.create-account",
    path: "/v1/accounts",
    idempotencyKey: simIdempotencyKey(e.id, "it.create-account"),
    body: { employeeRef: e.id, upn: upnFor(e), displayName: `${e.firstName} ${e.lastName}` },
    schema: Account,
  });
}

export function assignLicenses(
  c: IntegrationClient,
  e: EmployeeProfile,
  accountId: string,
  privileged: { approved: boolean; approvalRef: string | null },
) {
  const usePrivileged = e.needsPrivilegedAccess && privileged.approved;
  return c.call({
    operation: "it.assign-licenses",
    path: `/v1/accounts/${accountId}/licenses`,
    idempotencyKey: simIdempotencyKey(e.id, "it.assign-licenses"),
    body: {
      bundle: e.licenseBundle,
      privileged: usePrivileged,
      ...(usePrivileged && privileged.approvalRef ? { approvalRef: privileged.approvalRef } : {}),
    },
    schema: Licenses,
  });
}

export function orderDevice(c: IntegrationClient, e: EmployeeProfile, accountId: string) {
  return c.call({
    operation: "it.order-device",
    path: "/v1/device-orders",
    idempotencyKey: simIdempotencyKey(e.id, "it.order-device"),
    body: { accountId, profile: e.equipmentProfile, shipTo: e.workMode === "remote" ? `home address on file (${e.id})` : e.site },
    schema: DeviceOrder,
  });
}

export function getDeviceOrder(c: IntegrationClient, id: string) {
  return c.call({ operation: "it.get-device-order", path: `/v1/device-orders/${id}`, schema: DeviceOrder });
}

export function getAccount(c: IntegrationClient, id: string) {
  return c.call({ operation: "it.get-account", path: `/v1/accounts/${id}`, schema: AccountRecord });
}
