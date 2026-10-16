// What an employee sees about the blockers on their own case: one plain notice
// per kind of problem, with no ids, owner codes or rule names, and whether
// anything is needed from them.
import type { BlockerView } from "../../shared/api.ts";
import type { Department } from "../../shared/roles.ts";
import { SYSTEM_NAMES } from "./blocker-text.ts";

const TEAM_NAMES: Record<Department, string> = { people_ops: "People Operations", it: "IT", facilities: "Facilities" };

export function noticeFor(b: BlockerView): string {
  switch (b.kind) {
    case "approval_overdue":
    case "approval_rejected":
      return b.detail.checkpoint === "closeout"
        ? "Your final sign-off by People Operations is taking longer than planned. Nothing is needed from you."
        : "Your manager's approval is taking longer than planned. People Operations is following up. Nothing is needed from you.";
    case "integration_outage":
    case "data_issue":
    case "provisioning_stalled": {
      const sys = typeof b.detail.system === "string" ? b.detail.system : b.subject.split(".")[0];
      return `We hit a setup problem with ${SYSTEM_NAMES[sys ?? ""] ?? "one of our systems"} (a simulated system). The ${TEAM_NAMES[b.ownerDepartment]} team is fixing it.`;
    }
    case "employee_task_overdue": {
      const n = Number(b.detail.count ?? (Array.isArray(b.detail.taskIds) ? b.detail.taskIds.length : 0)) || 0;
      return n === 1 ? "1 of your tasks is past its due date." : `${n} of your tasks are past their due date.`;
    }
  }
}

export function EmployeeNotices({ blockers }: { blockers: BlockerView[] }) {
  const notices = [...new Set(blockers.filter((b) => b.status === "open").map(noticeFor))];
  if (notices.length === 0) return null;
  return (
    <section className="card notice" aria-label="Updates on your onboarding">
      <h2>Updates on your onboarding</h2>
      <ul className="notices">
        {notices.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}
