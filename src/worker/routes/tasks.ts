// /api/tasks/:taskId/complete: checklist tasks by their employee (or an admin), follow-ups by the owning department.
import { Hono } from "hono";
import { NoteBody } from "../../shared/api.ts";
import { canCompleteTask } from "../auth/policy.ts";
import { getTask } from "../db/repo.ts";
import { apiError, type AppEnv } from "../http.ts";
import { body, caseAgent, idempotent } from "./util.ts";

export function taskRoutes() {
  const r = new Hono<AppEnv>();
  r.post("/:taskId/complete", async (c) => {
    const task = await getTask(c.env.DB, c.req.param("taskId"));
    if (!task) return apiError(c, 404, "not_found", "unknown task");
    if (!canCompleteTask(c.get("principal"), { employeeId: task.employee_id, kind: task.kind, assignee: task.assignee })) {
      return apiError(c, 403, "forbidden", "not allowed to complete this task");
    }
    const b = await body(c, NoteBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, task.employee_id)).completeTask(task.id, cmd, b.value.note));
  });
  return r;
}
