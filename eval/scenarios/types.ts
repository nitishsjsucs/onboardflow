// Scenario file shape (SPEC 12.1). A scenario binds one fixed synthetic
// employee (checked against its archetype), a setup (fault plans and profile
// corruption applied before the case starts), a script of actions the
// harness executes through the real API as the real personas, and the
// expectations evaluated against the case snapshot afterwards.
import type { FaultPlanInput } from "../../src/shared/api.ts";
import type { AuditAction, BlockerKind, Checkpoint, EmploymentType, EquipmentProfile, FailureReason, StageStatus, SystemId, WorkMode } from "../../src/shared/domain.ts";
import type { Department } from "../../src/shared/roles.ts";
import type { StageId } from "../../src/shared/stages.ts";

/** Who performs an action. The harness maps these to seed personas for the scenario's employee. */
export type PersonaRef = "employee" | "manager" | "people_ops" | "people_ops_2" | "it" | "facilities" | "admin";

export type CorruptField = "costCenter" | "licenseBundle" | "photoOnFile";

export type Action =
  | { do: "start" }
  | { do: "completeEmployeeTasks"; stage: "paperwork" | "orientation"; order?: "reverse" }
  | { do: "decide"; checkpoint: Checkpoint; decision: "approve" | "reject"; as: PersonaRef; privileged?: boolean }
  | { do: "resubmit"; checkpoint: Checkpoint; as: PersonaRef }
  | { do: "advanceClock"; ms: number }
  | { do: "scan" }
  | { do: "waitStage"; stage: StageId; status: StageStatus }
  | { do: "corrupt"; field: CorruptField; value: unknown }
  | { do: "fixField"; field: CorruptField; as: PersonaRef; value?: unknown }
  | { do: "setFault"; plan: FaultPlanInput }
  | { do: "clearFaults"; system?: SystemId }
  | { do: "retryStage"; stage: StageId; as: PersonaRef; expectStatus?: number }
  | { do: "restart" }
  | { do: "terminate" }
  | { do: "evict"; kind: "case" | "hub" }
  | { do: "duplicate"; action: Action; sameKey: boolean }
  | { do: "completeFollowUp"; kind: BlockerKind; as: PersonaRef }
  | { do: "concurrent"; actions: Action[] }
  | { do: "expectBlockerStatus"; kind: BlockerKind; status: "open" | "resolved" };

export type ActionKind = Action["do"];

export type Archetype = Partial<{
  workMode: WorkMode;
  employmentType: EmploymentType;
  orgUnit: string;
  needsPrivilegedAccess: boolean;
  equipmentProfile: EquipmentProfile;
  startDate: string;
}>;

export type SetupItem = FaultPlanInput | { corrupt: { field: CorruptField; value: unknown } };

export type Category = "onboarding" | "integration_failure" | "recovery";

export type Scenario = {
  /** "O01", "F-it-lost-response", "R05" */
  id: string;
  category: Category;
  title: string;
  /** Fixed seed employee, checked against the archetype by eval-catalog.test.ts. */
  employeeId: string;
  archetype: Archetype;
  /** For integration-failure scenarios: the fault class and system they cover. */
  covers?: { faultClass: FaultClass; system: SystemId };
  /** Another scenario whose employee has the same manager (O13). */
  sameManagerAs?: string;
  /** Scenarios that move the shared simulated clock run serially after all others. */
  movesClock?: boolean;
  setup: SetupItem[];
  script: Action[];
  expect: {
    terminal: "complete" | { failed: FailureReason };
    /** operation -> attempts in its final round */
    attempts?: Record<string, number>;
    /** operation -> ledger count */
    sideEffects?: Record<string, 1>;
    /** operations that must show an idempotent replay */
    replayed?: string[];
    blockers?: Array<{ kind: BlockerKind; stage: StageId; ownerDepartment: Department }>;
    rounds?: Partial<Record<StageId, number>>;
    /** gates that must pass without waiting in the final run (restart scenarios) */
    gateChecks?: Partial<Record<StageId, 1>>;
    /** must appear for this case */
    auditActions?: AuditAction[];
    /** must not appear (for example case.failed after a restart) */
    absentAuditActions?: AuditAction[];
    /** exact counts of some audit actions */
    auditCounts?: Partial<Record<AuditAction, number>>;
  };
};

export const FAULT_CLASSES = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];
