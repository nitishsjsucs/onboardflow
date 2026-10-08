const TONE: Record<string, "ok" | "warn" | "bad" | "info" | "idle"> = {
  complete: "ok",
  approved: "ok",
  done: "ok",
  resolved: "ok",
  delivered: "ok",
  verified: "ok",
  active: "info",
  in_progress: "info",
  waiting_on_employee: "warn",
  awaiting_approval: "warn",
  pending: "idle",
  not_started: "idle",
  open: "warn",
  blocked: "bad",
  revision_requested: "bad",
  rejected: "bad",
  failed: "bad",
  cancelled: "idle",
};

export function label(status: string): string {
  return status.replace(/_/g, " ");
}

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? "idle";
  return <span className={`badge ${tone === "idle" ? "" : tone}`}>{label(status)}</span>;
}
