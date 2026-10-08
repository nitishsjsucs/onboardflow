// 24 integration-failure scenarios = 8 fault classes x 3 simulated systems
// (SPEC 12.2). Faulted operation per system: hr create-worker (stall on
// document verification), it order-device (stall on the device order),
// facilities issue-badge (stall on the badge).
import type { SystemId } from "../../src/shared/domain.ts";
import type { Department } from "../../src/shared/roles.ts";
import type { StageId } from "../../src/shared/stages.ts";
import { closeoutApproved, fault, happyPath, managerApproves, ONE_EACH, orientation, paperwork } from "./script.ts";
import type { Action, FaultClass, PersonaRef, Scenario } from "./types.ts";

type SystemTarget = {
  system: SystemId;
  op: string; // simulator operation name
  opId: string; // OperationId
  stallOp: string;
  stallPostOpId: string;
  stage: StageId;
  stallStage: StageId;
  owner: Department & PersonaRef;
};

const TARGETS: Record<SystemId, SystemTarget> = {
  hr: { system: "hr", op: "create-worker", opId: "hr.create-worker", stallOp: "get-document-verification", stallPostOpId: "hr.start-document-verification", stage: "intake", stallStage: "paperwork", owner: "people_ops" },
  it: { system: "it", op: "order-device", opId: "it.order-device", stallOp: "get-device-order", stallPostOpId: "it.order-device", stage: "it_provisioning", stallStage: "it_provisioning", owner: "it" },
  facilities: { system: "facilities", op: "issue-badge", opId: "facilities.issue-badge", stallOp: "get-badge", stallPostOpId: "facilities.issue-badge", stage: "facilities_setup", stallStage: "facilities_setup", owner: "facilities" },
};

const EMPLOYEES: Record<SystemId, Record<FaultClass, string>> = {
  hr: { F1: "E038", F2: "E041", F3: "E044", F4: "E047", F5: "E050", F6: "E053", F7: "E056", F8: "E059" },
  it: { F1: "E062", F2: "E065", F3: "E068", F4: "E071", F5: "E074", F6: "E005", F7: "E077", F8: "E080" },
  facilities: { F1: "E083", F2: "E086", F3: "E089", F4: "E092", F5: "E095", F6: "E098", F7: "E101", F8: "E104" },
};

const NAMES: Record<FaultClass, string> = { F1: "transient", F2: "rate-limit", F3: "timeout", F4: "lost-response", F5: "malformed", F6: "validation", F7: "outage", F8: "stall" };

/** Inserts the recovery actions right after the human step that precedes the faulted stage. */
function withRecovery(stage: StageId, recovery: Action[]): Action[] {
  const base = happyPath();
  // intake runs before any human step; paperwork's operation runs after the paperwork tasks;
  // IT and Facilities run after the manager approval.
  const at = stage === "intake" ? 0 : stage === "paperwork" ? 1 : 2;
  return [...base.slice(0, at), ...recovery, ...base.slice(at)];
}

function scenario(sys: SystemId, fc: FaultClass): Scenario {
  const t = TARGETS[sys];
  const employeeId = EMPLOYEES[sys][fc];
  const id = `F-${sys}-${NAMES[fc]}`;
  const base = { id, category: "integration_failure" as const, employeeId, covers: { faultClass: fc, system: sys } };
  const done = { terminal: "complete" as const, sideEffects: ONE_EACH };
  switch (fc) {
    case "F1":
      return { ...base, title: `${sys}: transient 503 x2 on ${t.opId}, retried automatically`, archetype: {}, setup: [fault(employeeId, sys, t.op, "fail_503", 2)], script: happyPath(), expect: { ...done, attempts: { [t.opId]: 3 }, blockers: [] } };
    case "F2":
      return { ...base, title: `${sys}: rate limited once with Retry-After on ${t.opId}`, archetype: {}, setup: [fault(employeeId, sys, t.op, "rate_limit_429", 1, { retryAfterMs: 100 })], script: happyPath(), expect: { ...done, attempts: { [t.opId]: 2 }, blockers: [] } };
    case "F3":
      return { ...base, title: `${sys}: one call to ${t.opId} times out (client timeout, then ok)`, archetype: {}, setup: [fault(employeeId, sys, t.op, "timeout", 1)], script: happyPath(), expect: { ...done, attempts: { [t.opId]: 2 }, blockers: [] } };
    case "F4":
      return {
        ...base,
        title: `${sys}: response to ${t.opId} lost after commit, retry replays by Idempotency-Key`,
        archetype: {},
        setup: [fault(employeeId, sys, t.op, "lost_response", 1)],
        script: happyPath(),
        expect: { ...done, attempts: { [t.opId]: 2 }, replayed: [t.opId], blockers: [] },
      };
    case "F5":
      return { ...base, title: `${sys}: malformed 200 from ${t.opId}, retried`, archetype: {}, setup: [fault(employeeId, sys, t.op, "malformed", 1)], script: happyPath(), expect: { ...done, attempts: { [t.opId]: 2 }, blockers: [] } };
    case "F6": {
      if (sys === "hr") {
        return {
          ...base,
          title: "hr: invalid cost center -> data issue to People Ops -> field fixed -> retry",
          archetype: {},
          setup: [{ corrupt: { field: "costCenter", value: "CC-12" } }],
          script: withRecovery("intake", [{ do: "waitStage", stage: "intake", status: "blocked" }, { do: "fixField", field: "costCenter", as: "people_ops" }, { do: "retryStage", stage: "intake", as: "people_ops" }]),
          expect: { ...done, rounds: { intake: 2 }, blockers: [{ kind: "data_issue", stage: "intake", ownerDepartment: "people_ops" }] },
        };
      }
      if (sys === "it") {
        return {
          ...base,
          title: "it: license bundle not allowed for a contractor -> data issue to IT -> field fixed -> retry",
          archetype: { employmentType: "contractor" },
          setup: [{ corrupt: { field: "licenseBundle", value: "ft-engineering" } }],
          script: withRecovery("it_provisioning", [{ do: "waitStage", stage: "it_provisioning", status: "blocked" }, { do: "fixField", field: "licenseBundle", as: "it" }, { do: "retryStage", stage: "it_provisioning", as: "it" }]),
          expect: { ...done, rounds: { it_provisioning: 2 }, blockers: [{ kind: "data_issue", stage: "it_provisioning", ownerDepartment: "it" }] },
        };
      }
      return {
        ...base,
        title: "facilities: badge photo missing -> data issue to Facilities -> field fixed -> retry",
        archetype: {},
        setup: [],
        // completing the badge_photo task sets the flag, so the corruption happens after paperwork
        script: [
          paperwork(),
          { do: "waitStage", stage: "paperwork", status: "complete" },
          { do: "corrupt", field: "photoOnFile", value: 0 },
          managerApproves(),
          { do: "waitStage", stage: "facilities_setup", status: "blocked" },
          { do: "fixField", field: "photoOnFile", as: "facilities" },
          { do: "retryStage", stage: "facilities_setup", as: "facilities" },
          orientation(),
          closeoutApproved(),
        ],
        expect: { ...done, rounds: { facilities_setup: 2 }, blockers: [{ kind: "data_issue", stage: "facilities_setup", ownerDepartment: "facilities" }] },
      };
    }
    case "F7":
      return {
        ...base,
        title: `${sys}: sustained outage on ${t.opId} beyond the retry budget -> blocker -> fault cleared -> retry`,
        archetype: {},
        setup: [fault(employeeId, sys, t.op, "fail_503", null)],
        script: withRecovery(t.stage, [{ do: "waitStage", stage: t.stage, status: "blocked" }, { do: "clearFaults" }, { do: "retryStage", stage: t.stage, as: t.owner }]),
        expect: { ...done, attempts: { [t.opId]: 1 }, rounds: { [t.stage]: 2 }, blockers: [{ kind: "integration_outage", stage: t.stage, ownerDepartment: t.owner }] },
      };
    case "F8":
      return {
        ...base,
        title: `${sys}: ${t.stallOp} stalls past POLL_MAX -> provisioning stalled -> fault cleared -> retry replays the order`,
        archetype: {},
        setup: [fault(employeeId, sys, t.stallOp, "stall", null)],
        script: withRecovery(t.stallStage, [{ do: "waitStage", stage: t.stallStage, status: "blocked" }, { do: "clearFaults" }, { do: "retryStage", stage: t.stallStage, as: t.owner }]),
        expect: { ...done, replayed: [t.stallPostOpId], rounds: { [t.stallStage]: 2 }, blockers: [{ kind: "provisioning_stalled", stage: t.stallStage, ownerDepartment: t.owner }] },
      };
  }
}

export const INTEGRATION_FAILURES: Scenario[] = (["hr", "it", "facilities"] as const).flatMap((sys) =>
  (["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"] as const).map((fc) => scenario(sys, fc)),
);
