// Plain vars the worker test project hands Miniflare on top of wrangler.jsonc
// (vitest.config.ts spreads them into its bindings). Kept in one constant so
// test/node/step-budget.test.ts checks the workflow's loop bounds under the
// exact values the worker tests run with.
export const WORKER_TEST_VARS = {
  EVAL_HOOKS: "on",
  SIM_CLOCK: "on",
  RETRY_BASE_DELAY_MS: "10",
  POLL_INTERVAL_MS: "10",
  INTEGRATION_TIMEOUT_MS: "2000",
  GATE_WAIT_TIMEOUT_MS: "1000",
  NUDGE_AFTER_S: "1",
  HUB_DEBOUNCE_S: "1",
  BLOCKER_SCAN_INTERVAL_S: "3600",
} as const;
