// /api/dashboard: read-only aggregates for coordinators and admins (the same
// role gate as the live hub: view_dashboard).
//   /summary          the dashboard aggregates recomputed from D1 on request, in the same shape as the
//                     live OpsHubAgent state (and the hub consistency check).
//   /start-readiness  people starting each week from today, by readiness for day one: one grouped
//                     statement over employees (150 rows in the seed) with primary-key lookups of their
//                     case and current stage, bucketed in src/shared/readiness.ts. "Today" is the viewer's
//                     calendar date when the request sends one (within a day of the server's), so the
//                     countdowns match the case page, My team and Approvals, which count in local time.
//   /changes          the latest case events of a fixed list of audit actions, newest first, with
//                     whitelisted detail fields only. One indexed statement per action in one batch
//                     (audit_action is (action, seq), read newest first), so the rows read stay bounded
//                     by the number of actions times the limit however large the audit log grows. The
//                     hub's recentActivity is left as it is: the eval's hub consistency check compares it.
import { Hono } from "hono";
import type { HubState } from "../../shared/agent-state.ts";
import { CHANGE_ACTIONS, type ChangeItem, ChangesQuery, type ChangesDto, StartReadinessQuery, type StartReadinessDto } from "../../shared/api.ts";
import { type ActorType, BLOCKER_KINDS, type CaseStatus, CHECKPOINTS, FAILURE_REASONS, isOneOf, type StageStatus, SYSTEM_IDS } from "../../shared/domain.ts";
import { bucketReadiness, dayIndex, readinessWindow } from "../../shared/readiness.ts";
import { isStageId, type StageId } from "../../shared/stages.ts";
import { computeHubDomain } from "../agents/projection.ts";
import { requireRole } from "../auth/middleware.ts";
import { apiError, type AppEnv } from "../http.ts";
import { query } from "./util.ts";

export const DEFAULT_READINESS_WEEKS = 12;
export const DEFAULT_CHANGES = 15;
/** blocker.opened rows read per request: only three kinds are shown (the others repeat stage.blocked), filtered from these. */
export const BLOCKER_OPENED_SCAN = 150;
const SHOWN_BLOCKER_KINDS = ["approval_overdue", "employee_task_overdue", "approval_rejected"] as const;

type ChangeRow = {
  seq: number;
  occurred_at: string;
  action: ChangeItem["action"];
  employee_id: string;
  stage_id: string | null;
  round: number | null;
  actor_type: ActorType;
  entity_id: string;
  detail_json: string;
  employee_name: string;
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const shortText = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);

/**
 * The detail fields the feed may show, checked one by one: enums against their vocabularies, numbers as
 * integers, a staff id or "people_ops" for onBehalfOf. Reasons, notes, request ids and emails never pass.
 */
export function changeDetail(row: Pick<ChangeRow, "action" | "stage_id" | "detail_json">): ChangeItem["detail"] {
  let d: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.detail_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) d = parsed as Record<string, unknown>;
  } catch {
    d = {};
  }
  const out: ChangeItem["detail"] = {};
  if (isOneOf(BLOCKER_KINDS, d.kind)) out.kind = d.kind;
  if (isOneOf(SYSTEM_IDS, d.system)) out.system = d.system;
  const operation = shortText(d.operation, 64);
  if (operation && /^[a-z]+\.[a-z-]+$/.test(operation)) out.operation = operation;
  if (isInt(d.httpStatus)) out.httpStatus = d.httpStatus;
  const message = shortText(d.message, 200);
  if (message && !message.includes("@")) out.message = message;
  if (isOneOf(CHECKPOINTS, d.checkpoint)) out.checkpoint = d.checkpoint;
  if (isInt(d.round)) out.round = d.round;
  if (isOneOf(FAILURE_REASONS, d.failureReason)) out.failureReason = d.failureReason;
  if (typeof d.onBehalfOf === "string" && /^[A-Za-z0-9_]{1,32}$/.test(d.onBehalfOf)) out.onBehalfOf = d.onBehalfOf;
  // an approval's (or an approval blocker's) stage is its checkpoint
  if ((row.action.startsWith("approval.") || row.action === "blocker.opened") && isOneOf(CHECKPOINTS, row.stage_id)) out.checkpoint = row.stage_id;
  return out;
}

/** The stage of a change: the audit row's, or for a blocker event the one in its id (blk:{employee}:{kind}:{stage}:...). */
function changeStage(row: Pick<ChangeRow, "stage_id" | "entity_id">): StageId | null {
  if (isStageId(row.stage_id)) return row.stage_id;
  const fromId = row.entity_id.startsWith("blk:") ? row.entity_id.split(":")[3] : undefined;
  return isStageId(fromId) ? fromId : null;
}

export function dashboardRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/summary", requireRole("coordinator", "admin"), async (c) => {
    const now = c.get("clock").nowIso();
    const { domain, asOfSeq } = await computeHubDomain(c.env.DB, now);
    const body: HubState = { ...domain, asOfSeq, reconciledAt: now, version: 0 };
    return c.json(body);
  });

  // No Cache-Control: a browser cache would outlive Switch persona, which clears only the query cache.
  r.get("/start-readiness", requireRole("coordinator", "admin"), async (c) => {
    const q = query(c, StartReadinessQuery);
    if (!q.ok) return q.response;
    const weeks = q.value.weeks ?? DEFAULT_READINESS_WEEKS;
    const serverToday = c.get("clock").nowIso().slice(0, 10);
    const today = q.value.today ?? serverToday;
    // every time zone's date is within a day of UTC's; anything further is not a viewer's today
    if (Math.abs(dayIndex(today)! - dayIndex(serverToday)!) > 1) return apiError(c, 400, "invalid_request", `today: must be within one day of the server's date (${serverToday})`);
    const { end } = readinessWindow(today, weeks);
    // Start dates before `end`; of those before today, only cases that are not complete (already started, not finished).
    const rows = await c.env.DB.prepare(
      `SELECT e.start_date, c.status AS case_status, c.current_stage, cs.status AS stage_status, COUNT(*) AS n
         FROM employees e
         JOIN cases c ON c.employee_id = e.id
         LEFT JOIN case_stages cs ON cs.employee_id = c.employee_id AND cs.stage_id = c.current_stage
        WHERE e.start_date < ? AND (e.start_date >= ? OR c.status <> 'complete')
        GROUP BY e.start_date, c.status, c.current_stage, cs.status`,
    )
      .bind(end, today)
      .all<{ start_date: string; case_status: CaseStatus; current_stage: StageId | null; stage_status: StageStatus | null; n: number }>();
    const body: StartReadinessDto = bucketReadiness(
      rows.results.map((x) => ({ startDate: x.start_date, caseStatus: x.case_status, currentStage: x.current_stage, stageStatus: x.stage_status, n: x.n })),
      today,
      weeks,
    );
    return c.json(body);
  });
  r.get("/changes", requireRole("coordinator", "admin"), async (c) => {
    const q = query(c, ChangesQuery);
    if (!q.ok) return q.response;
    const limit = q.value.limit ?? DEFAULT_CHANGES;
    // One statement per action in one batch (D1 refuses a compound SELECT of ten terms), each reading the
    // action's newest rows from the audit_action index, then a merge by seq: at most actions x limit rows.
    const cols = "a.seq, a.occurred_at, a.action, a.employee_id, a.stage_id, a.round, a.actor_type, a.entity_id, a.detail_json, e.first_name || ' ' || e.last_name AS employee_name";
    const statements = CHANGE_ACTIONS.map((action) =>
      action === "blocker.opened"
        ? c.env.DB.prepare(
            `SELECT ${cols} FROM (SELECT * FROM audit_events WHERE action = ? AND employee_id IS NOT NULL ORDER BY seq DESC LIMIT ?) a
               JOIN employees e ON e.id = a.employee_id
              WHERE json_extract(a.detail_json, '$.kind') IN (${SHOWN_BLOCKER_KINDS.map(() => "?").join(", ")})
              ORDER BY a.seq DESC LIMIT ?`,
          ).bind(action, BLOCKER_OPENED_SCAN, ...SHOWN_BLOCKER_KINDS, limit)
        : c.env.DB.prepare(
            `SELECT ${cols} FROM audit_events a JOIN employees e ON e.id = a.employee_id
              WHERE a.action = ? AND a.employee_id IS NOT NULL ORDER BY a.seq DESC LIMIT ?`,
          ).bind(action, limit),
    );
    const results = await c.env.DB.batch<ChangeRow>(statements);
    const rows = results
      .flatMap((r) => r.results)
      .sort((x, y) => y.seq - x.seq)
      .slice(0, limit);
    const body: ChangesDto = {
      items: rows.map((x) => ({
        seq: x.seq,
        occurredAt: x.occurred_at,
        action: x.action,
        employeeId: x.employee_id,
        employeeName: x.employee_name,
        stageId: changeStage(x),
        round: x.round,
        actorType: x.actor_type,
        detail: changeDetail(x),
      })),
    };
    return c.json(body);
  });
  return r;
}
