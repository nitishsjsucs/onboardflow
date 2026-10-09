// TanStack Query hooks over the API. Live agent state invalidates these keys.
import { apiFetch, newIdempotencyKey } from "./client.ts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalView, AuditEventView, BlockerView, CaseDetail, ChecklistDto, EmployeeProfileDto, EmployeeSummary, IntegrationCallView, MeDto, Page, TaskView } from "../../shared/api.ts";
import type { HubState } from "../../shared/agent-state.ts";

export const keys = {
  me: ["me"] as const,
  checklist: ["me", "checklist"] as const,
  case: (id: string) => ["case", id] as const,
  caseAudit: (id: string) => ["case", id, "audit"] as const,
  employees: (q: string) => ["employees", q] as const,
  approvals: (status: string) => ["approvals", status] as const,
  blockers: ["blockers"] as const,
  followups: ["followups"] as const,
  dashboard: ["dashboard"] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => apiFetch<MeDto>("/api/me"), retry: false });
}

export function useChecklist(enabled = true) {
  return useQuery({ queryKey: keys.checklist, queryFn: () => apiFetch<ChecklistDto>("/api/me/checklist"), enabled });
}

/** Completes a task with one Idempotency-Key per click, and updates the checklist optimistically. */
export function useCompleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string; key?: string }) =>
      apiFetch<TaskView>(`/api/tasks/${encodeURIComponent(v.taskId)}/complete`, { method: "POST", body: {}, idempotencyKey: v.key ?? newIdempotencyKey() }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: keys.checklist });
      const previous = qc.getQueryData<ChecklistDto>(keys.checklist);
      if (previous) {
        qc.setQueryData<ChecklistDto>(keys.checklist, {
          ...previous,
          tasks: previous.tasks.map((t) => (t.id === v.taskId ? { ...t, status: "done" } : t)),
        });
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(keys.checklist, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.checklist }),
  });
}

// ---------------------------------------------------------------------------
// Approvals, queue, cases
// ---------------------------------------------------------------------------

export function useApprovals(status: "pending" | "rejected" | "all" = "pending", enabled = true) {
  return useQuery({ queryKey: keys.approvals(status), queryFn: () => apiFetch<Page<ApprovalView>>(`/api/approvals?status=${status}&limit=100`), enabled });
}

function useAction<V>(fn: (v: V & { key: string }) => Promise<unknown>, invalidate: ReadonlyArray<readonly unknown[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V & { key?: string }) => fn({ ...v, key: v.key ?? newIdempotencyKey() } as V & { key: string }),
    onSettled: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

export function useDecide() {
  return useAction<{ approvalId: string; decision: "approve" | "reject"; reason?: string; privilegedAccessApproved?: boolean }>(
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
  return useAction<{ approvalId: string; note: string }>(
    (v) => apiFetch(`/api/approvals/${encodeURIComponent(v.approvalId)}/resubmit`, { method: "POST", body: { note: v.note }, idempotencyKey: v.key }),
    [["approvals"], ["case"]],
  );
}

export function useBlockers(status: "open" | "resolved" | "all" = "open") {
  return useQuery({ queryKey: [...keys.blockers, status], queryFn: () => apiFetch<Page<BlockerView>>(`/api/blockers?status=${status}&limit=100`) });
}

export function useFollowups() {
  return useQuery({ queryKey: keys.followups, queryFn: () => apiFetch<Page<TaskView>>("/api/followups?limit=100") });
}

export function useRetryStage() {
  return useAction<{ employeeId: string; stageId: string; note?: string }>(
    (v) => apiFetch(`/api/cases/${v.employeeId}/stages/${v.stageId}/retry`, { method: "POST", body: v.note ? { note: v.note } : {}, idempotencyKey: v.key }),
    [keys.blockers, keys.followups, ["case"]],
  );
}

export function useResolveBlocker() {
  return useAction<{ blockerId: string; resolution: string }>(
    (v) => apiFetch(`/api/blockers/${encodeURIComponent(v.blockerId)}/resolve`, { method: "POST", body: { resolution: v.resolution }, idempotencyKey: v.key }),
    [keys.blockers, keys.followups, ["case"]],
  );
}

export function useCompleteFollowup() {
  return useAction<{ taskId: string }>(
    (v) => apiFetch(`/api/tasks/${encodeURIComponent(v.taskId)}/complete`, { method: "POST", body: {}, idempotencyKey: v.key }),
    [keys.followups, ["case"]],
  );
}

export function useFixField() {
  return useAction<{ employeeId: string; field: "costCenter" | "licenseBundle" | "photoOnFile"; value: string | boolean }>(
    (v) => apiFetch<EmployeeProfileDto>(`/api/employees/${v.employeeId}`, { method: "PATCH", body: { [v.field]: v.value }, idempotencyKey: v.key }),
    [["case"], keys.blockers],
  );
}

export type EmployeeFilters = { q?: string; status?: string; stage?: string };

export function useEmployees(f: EmployeeFilters) {
  const params = new URLSearchParams({ limit: "100" });
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
  const qs = params.toString();
  return useQuery({ queryKey: keys.employees(qs), queryFn: () => apiFetch<Page<EmployeeSummary>>(`/api/employees?${qs}`) });
}

export function useStartCase() {
  return useAction<{ employeeId: string }>(
    (v) => apiFetch(`/api/cases/${v.employeeId}/start`, { method: "POST", body: {}, idempotencyKey: v.key }),
    [["employees"], ["case"]],
  );
}

export function useCase(id: string) {
  return useQuery({ queryKey: keys.case(id), queryFn: () => apiFetch<CaseDetail>(`/api/cases/${id}`) });
}

export function useCaseAudit(id: string, pageSize = 25) {
  return useInfiniteQuery({
    queryKey: keys.caseAudit(id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => apiFetch<Page<AuditEventView>>(`/api/cases/${id}/audit?limit=${pageSize}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useAdminCaseAction(kind: "restart" | "terminate") {
  return useAction<{ employeeId: string; reason: string }>(
    (v) => apiFetch(`/api/cases/${v.employeeId}/${kind}`, { method: "POST", body: { reason: v.reason }, idempotencyKey: v.key }),
    [["case"], ["employees"]],
  );
}

export function useDashboardSummary(enabled = true) {
  return useQuery({ queryKey: keys.dashboard, queryFn: () => apiFetch<HubState>("/api/dashboard/summary"), enabled });
}

// ---------------------------------------------------------------------------
// Integrations and audit explorer
// ---------------------------------------------------------------------------
export function useIntegrationHealth(window: "1h" | "24h" | "7d" | "all") {
  return useQuery({ queryKey: ["integrations", "health", window], queryFn: () => apiFetch<HubState["integrationHealth"]>(`/api/integrations/health?window=${window}`) });
}

export function useCaseIntegrations(employeeId: string) {
  return useInfiniteQuery({
    queryKey: ["case", employeeId, "integrations"],
    enabled: /^E\d{3}$/.test(employeeId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => apiFetch<Page<IntegrationCallView>>(`/api/cases/${employeeId}/integrations?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
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
    queryFn: ({ pageParam }) => apiFetch<Page<AuditEventView>>(`/api/audit?${qs}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}
