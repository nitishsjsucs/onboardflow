import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/web/api/client.ts";
import { describeError, errorText, UNKNOWN_OUTCOME } from "../../src/web/api/errors.ts";

const err = (status: number, code: string, message = "x", requestId: string | null = "req-1") => new ApiError(status, code, message, requestId);

// Every code the server sends, with the message it sends, as the API answers it.
const CASES: Array<[ApiError, RegExp]> = [
  [err(0, "network", "Failed to fetch", null), /^Could not reach OnboardFlow\. Check your connection, or reload the page to sign in again\.$/],
  [err(502, "non_json_response"), /could not read \(HTTP 502\)/],
  [err(409, "idempotency_in_progress", "a request with this Idempotency-Key is in progress"), /still being processed/],
  [err(409, "stage_not_blocked", "stage is active"), /not blocked right now \(active\), so there is nothing to retry/],
  [err(409, "stage_not_started", "the manager_approval stage has not started yet; its tasks open when it does"), /^Manager approval of equipment and access has not started yet\.$/],
  [err(409, "task_not_open", "task is done"), /already done/],
  [err(409, "approval_not_pending", "approval is approved"), /^Already decided\.$/],
  [err(409, "blocker_not_open", "blocker is resolved"), /already resolved/],
  [err(409, "field_locked_by_approval", "the license bundle was part of the manager's approval request; it can change only to correct an open data issue"), /part of the manager's approval/],
  [err(409, "field_changed", "the field changed concurrently; reload and retry"), /changed this field at the same time/],
  [err(409, "case_finished", "case is complete"), /already ended \(complete\)/],
  [err(409, "restart_conflict", "the case changed concurrently"), /changed while the restart/],
  [err(409, "not_started", "the case has not started"), /has not started/],
  [err(409, "not_revision_requested", "the stage is not awaiting a resubmission for this round"), /no longer waiting for a resubmission/],
  [err(400, "invalid_request", "resolution: Too small: expected string to have >=1 characters"), /^The reason is required\.$/],
  [err(400, "invalid_request", "costCenter: Too big: expected string to have <=32 characters; licenseBundle: Invalid option: expected one of \"ft-standard\"|\"ft-engineering\""), /^The cost center is too long; the license bundle is not one of the allowed values\.$/],
  [err(403, "forbidden", "owned by it"), /do not have permission/],
  [err(401, "unauthenticated", "missing token"), /^Your session ended\.$/],
  [err(404, "not_found", "unknown blocker"), /was not found/],
  [err(503, "workflow_create_failed", "the workflow could not be created yet; retry"), /could not be started yet/],
  [err(500, "internal_error", "internal error"), /went wrong on the server/],
  [err(418, "teapot", "short and stout"), /\(HTTP 418\)/],
];

describe("describeError", () => {
  it.each(CASES.map(([e, re]) => [`${e.status} ${e.code}`, e, re] as const))("%s", (_name, e, expected) => {
    const d = describeError(e, { action: "retry IT provisioning" });
    expect(d.message).toMatch(expected);
    expect(d.next).toBeTruthy();
    expect(d.requestId).toBe(e.requestId);
    const text = `${d.message} ${d.next}`.replaceAll("OnboardFlow", "the app");
    // no raw ids, codes, camelCase or snake_case reach the reader
    expect(text).not.toMatch(/[a-z][A-Z]|\w_\w|apr:|blk:|E\d{3}|Idempotency-Key|Too small|expected string/);
  });

  it("says a retry is safe only for mutations whose outcome is unknown", () => {
    expect(describeError(err(0, "network"), { action: "start onboarding" }).next).toBe(UNKNOWN_OUTCOME);
    expect(describeError(err(200, "non_json_response"), { action: "start onboarding" }).next).toBe(UNKNOWN_OUTCOME);
    expect(describeError(err(500, "internal_error"), { action: "start onboarding" }).next).toBe(UNKNOWN_OUTCOME);
    // a query is not an action that may have gone through
    expect(describeError(err(0, "network")).next).toBe("Try again.");
    // a final answer is not an unknown outcome
    expect(describeError(err(409, "stage_not_blocked", "stage is active"), { action: "retry" }).next).not.toBe(UNKNOWN_OUTCOME);
    // anything that is not an ApiError is unknown too
    expect(describeError(new TypeError("x"), { action: "retry" }).next).toBe(UNKNOWN_OUTCOME);
  });

  it("names the subject and the action where it helps", () => {
    expect(describeError(err(404, "not_found"), { subject: "case E999" }).message).toBe("Case E999 was not found.");
    expect(describeError(err(409, "stage_not_blocked", "stage is active"), { action: "retry", subject: "IT provisioning" }).message).toBe(
      "IT provisioning is not blocked right now (active), so there is nothing to retry.",
    );
    expect(describeError(err(418, "teapot"), { action: "retry IT provisioning" }).message).toBe("Could not retry IT provisioning (HTTP 418).");
    expect(errorText(err(409, "approval_not_pending"))).toBe("Already decided. Nothing more to do.");
  });
});
