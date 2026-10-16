// TanStack Query hooks over the API. Live agent state invalidates these keys.
import { actionId, actionKeys } from "./action-keys.ts";
import { apiFetch } from "./client.ts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalView, AuditEventView, BlockerView, CaseDetail, ChecklistDto, EmployeeProfileDto, EmployeeSummary, IntegrationCallView, MeDto, Page, TaskView } from "../../shared/api.ts";
import type { HubState } from "../../shared/agent-state.ts";

export type RoundResult = { round: number };

export const keys = {
  me: ["me"] as const,
  checklist: ["me", "checklist"] as const,
  case: (id: string) => ["case", id] as const,
  caseAudit: (id: string) => ["case", id, "audit"] as const,
  employees: (q: string) => ["employees", q] as const,
  employee: (id: string) => ["employee", id] as const,
  approvals: (status: string) => ["approvals", status] as const,
  blockers: ["blockers"] as const,
  followups: ["followups"] as const,
  dashboard: ["dashboard"] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: ({ signal }) => apiFetch<MeDto>("/api/me", { signal }), retry: false });
}

export function useChecklist(enabled = true) {
  return useQuery({ queryKey: keys.checklist, queryFn: ({ signal }) => apiFetch<ChecklistDto>("/api/me/checklist", { signal }), enabled });
}

/**
 * Completes a checklist task or a follow-up (same endpoint) with one Idempotency-Key per action
 * (reused on a retry, see action-keys.ts). The checklist changes only once the server confirmed:
 * an optimistic "done" removed the Mark done button that had focus, and a failure put it back with
 * focus on <body>, so a keyboard user could not simply press Enter again.
 */
export function useCompleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string }) =>
      apiFetch<TaskView>(`/api/tasks/${encodeURIComponent(v.taskId)}/complete`, { method: "POST", body: {}, idempotencyKey: actionKeys.keyFor(actionId("completeTask", v)) }),
    onSuccess: (_d, v) => {
      actionKeys.settle(actionId("completeTask", v), null);
      const current = qc.getQueryData<ChecklistDto>(keys.checklist);
      if (current) qc.setQueryData<ChecklistDto>(keys.checklist, { ...current, tasks: current.tasks.map((t) => (t.id === v.taskId ? { ...t, status: "done" } : t)) });
    },
    onError: (e, v) => actionKeys.settle(actionId("completeTask", v), e),
    onSettled: () => Promise.all([keys.checklist, keys.followups, ["case"]].map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

// ---------------------------------------------------------------------------
// Approvals, queue, cases
// ---------------------------------------------------------------------------

/** Refetches when the window regains focus: managers have no live hub, and a decision may have come from another tab. */
export function useApprovals(status: "pending" | "rejected" | "all" = "pending", enabled = true) {
  return useQuery({
    queryKey: keys.approvals(status),
    queryFn: ({ signal }) => apiFetch<Page<ApprovalView>>(`/api/approvals?status=${status}&limit=100`, { signal }),
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * A mutation whose Idempotency-Key belongs to the user action (name + input), not to the click:
 * a retry after an unknown outcome reuses it, a final answer forgets it (action-keys.ts).
 */
function useAction<V extends object, R = unknown>(name: string, fn: (v: V & { key: string }) => Promise<R>, invalidate: ReadonlyArray<readonly unknown[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => fn({ ...v, key: actionKeys.keyFor(actionId(name, v)) }),
    onSuccess: (_d, v) => actionKeys.settle(actionId(name, v), null),
    onError: (e, v) => actionKeys.settle(actionId(name, v), e),
    onSettled: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

export function useDecide() {
  return useAction<{ approvalId: string; decision: "approve" | "reject"; reason?: string; privilegedAccessApproved?: boolean }, ApprovalView>(
    "decide",
    (v) =>
      apiFetch<ApprovalView>(`/api/approvals/${encodeURIComponent(v.approvalId)}/decision`, {
        method: "POST",
        body: { decision: v.decision, ...(v.reason ? { reason: v.reason } : {}), ...(v.privilegedAccessApproved !== undefined ? { privilegedAccessApproved: v.privilegedAccessApproved } : {}) },
        idempotencyKey: v.key,
      }),
    [["approvals"], ["case"]],
  );
}

export function useResubmit() {
  return useAction<{ approvalId: string; note: string }, RoundResult>(
    "resubmit",
    (v) => apiFetch<RoundResult>(`/api/approvals/${encodeURIComponent(v.approvalId)}/resubmit`, { method: "POST", body: { note: v.note }, idempotencyKey: v.key }),
    [["approvals"], ["case"]],
  );
}

export type QueueFilters = { kind?: string | null; department?: string | null };

function queueParams(base: Record<string, string>, f: QueueFilters): string {
  const params = new URLSearchParams(base);
  if (f.kind) params.set("kind", f.kind);
  if (f.department) params.set("department", f.department);
  return params.toString();
}

/** Open blockers, filtered on the server (a coordinator's department is forced there), one page of 100 at a time. */
export function useOpenBlockers(f: QueueFilters, enabled = true) {
  const qs = queueParams({ status: "open", limit: "100" }, f);
  return useInfiniteQuery({
    queryKey: [...keys.blockers, "open", qs],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiFetch<Page<BlockerView>>(`/api/blockers?${qs}${pageParam ? `&cursor=${pageParam}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Open follow-ups of the department (admins may pick one), one page of 100 at a time. */
export function useOpenFollowups(department?: string | null) {
  const qs = queueParams({ limit: "100" }, { department });
  return useInfiniteQuery({
    queryKey: [...keys.followups, qs],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiFetch<Page<TaskView>>(`/api/followups?${qs}${pageParam ? `&cursor=${pageParam}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useRetryStage() {
  return useAction<{ employeeId: string; stageId: string; note?: string }, RoundResult>(
    "retryStage",
    (v) => apiFetch<RoundResult>(`/api/cases/${v.employeeId}/stages/${v.stageId}/retry`, { method: "POST", body: v.note ? { note: v.note } : {}, idempotencyKey: v.key }),
    [keys.blockers, keys.followups, ["case"]],
  );
}

export function useResolveBlocker() {
  return useAction<{ blockerId: string; resolution: string }, BlockerView>(
    "resolveBlocker",
    (v) => apiFetch<BlockerView>(`/api/blockers/${encodeURIComponent(v.blockerId)}/resolve`, { method: "POST", body: { resolution: v.resolution }, idempotencyKey: v.key }),
    [keys.blockers, keys.followups, ["case"]],
  );
}

export function useFixField() {
  return useAction<{ employeeId: string; field: "costCenter" | "licenseBundle" | "photoOnFile"; value: string | boolean }, EmployeeProfileDto>(
    "fixField",
    (v) => apiFetch<EmployeeProfileDto>(`/api/employees/${v.employeeId}`, { method: "PATCH", body: { [v.field]: v.value }, idempotencyKey: v.key }),
    [["case"], keys.blockers, ["employee"]],
  );
}

/** One employee's profile (the values a data issue is about). Coordinators and admins may read any; enable it only where it is shown. */
export function useEmployeeProfile(id: string, enabled = true) {
  return useQuery({ queryKey: keys.employee(id), queryFn: ({ signal }) => apiFetch<EmployeeProfileDto>(`/api/employees/${encodeURIComponent(id)}`, { signal }), enabled });
}

export type EmployeeFilters = { q?: string; status?: string; stage?: string };

/** Employees matching the filters, 100 per page; Load more follows nextCursor (the API reports no total). */
export function useEmployees(f: EmployeeFilters) {
  const params = new URLSearchParams({ limit: "100" });
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
  const qs = params.toString();
  return useInfiniteQuery({
    queryKey: keys.employees(qs),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiFetch<Page<EmployeeSummary>>(`/api/employees?${qs}${pageParam ? `&cursor=${pageParam}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useStartCase() {
  return useAction<{ employeeId: string }, { instanceId: string; created: boolean }>(
    "startCase",
    (v) => apiFetch<{ instanceId: string; created: boolean }>(`/api/cases/${v.employeeId}/start`, { method: "POST", body: {}, idempotencyKey: v.key }),
    [["employees"], ["case"]],
  );
}

export function useCase(id: string) {
  return useQuery({ queryKey: keys.case(id), queryFn: ({ signal }) => apiFetch<CaseDetail>(`/api/cases/${id}`, { signal }) });
}

export function useCaseAudit(id: string, pageSize = 25) {
  return useInfiniteQuery({
    queryKey: keys.caseAudit(id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiFetch<Page<AuditEventView>>(`/api/cases/${id}/audit?limit=${pageSize}${pageParam ? `&cursor=${pageParam}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Restart answers 202 { runNo, instanceId }; terminate answers 202 { status: "failed", failureReason: "terminated" }. */
export function useAdminCaseAction(kind: "restart" | "terminate") {
  return useAction<{ employeeId: string; reason: string }, { runNo?: number; instanceId?: string; status?: string }>(
    kind,
    (v) => apiFetch(`/api/cases/${v.employeeId}/${kind}`, { method: "POST", body: { reason: v.reason }, idempotencyKey: v.key }),
    [["case"], ["employees"]],
  );
}

export function useDashboardSummary(enabled = true) {
  return useQuery({ queryKey: keys.dashboard, queryFn: ({ signal }) => apiFetch<HubState>("/api/dashboard/summary", { signal }), enabled });
}

// ---------------------------------------------------------------------------
// Integrations and audit explorer
// ---------------------------------------------------------------------------
export function useIntegrationHealth(window: "1h" | "24h" | "7d" | "all") {
  return useQuery({ queryKey: ["integrations", "health", window], queryFn: ({ signal }) => apiFetch<HubState["integrationHealth"]>(`/api/integrations/health?window=${window}`, { signal }) });
}

export function useCaseIntegrations(employeeId: string) {
  return useInfiniteQuery({
    queryKey: ["case", employeeId, "integrations"],
    enabled: /^E\d{3}$/.test(employeeId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiFetch<Page<IntegrationCallView>>(`/api/cases/${employeeId}/integrations?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export type AuditFilters = { action?: string; actor?: string; employeeId?: string };

export function useAuditExplorer(f: AuditFilters, pageSize = 50) {
  const params = new URLSearchParams({ limit: String(pageSize) });
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
  const qs = params.toString();
  return useInfiniteQuery({
    queryKey: ["audit", qs],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiFetch<Page<AuditEventView>>(`/api/audit?${qs}${pageParam ? `&cursor=${pageParam}` : ""}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
  });
}
