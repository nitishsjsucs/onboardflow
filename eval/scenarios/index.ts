// The 60-scenario catalog: 20 onboarding, 24 integration-failure (8 fault
// classes x 3 systems), 16 recovery. Changes after the first recorded run are
// logged in eval/results/CHANGELOG.md with their reason.
import { INTEGRATION_FAILURES } from "./integration-failures.ts";
import { ONBOARDING } from "./onboarding.ts";
import { RECOVERY } from "./recovery.ts";
import type { Scenario } from "./types.ts";

export const SCENARIOS: Scenario[] = [...ONBOARDING, ...INTEGRATION_FAILURES, ...RECOVERY];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
