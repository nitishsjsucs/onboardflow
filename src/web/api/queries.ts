// TanStack Query hooks over the API. Live agent state invalidates these keys.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChecklistDto, MeDto, TaskView } from "../../shared/api.ts";
import { apiFetch, newIdempotencyKey } from "./client.ts";

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
