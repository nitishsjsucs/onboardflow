// Plain-language descriptions of API failures: what happened, what to do next,
// and the request id to quote. Every error code the server sends has its own
// wording; anything else falls back to a sentence that names the HTTP status.
// Messages never show raw ids, codes or field names (errors.test.ts).
import { isStageId, STAGE_BY_ID } from "../../shared/stages.ts";
import { outcomeUnknown } from "./action-keys.ts";
import { ApiError } from "./client.ts";

/** `action` marks a mutation ("retry IT provisioning"); `subject` names the thing it was about ("case E999"). */
export type ErrorContext = { action?: string; subject?: string };
export type DescribedError = { message: string; next: string | null; requestId: string | null };

export const UNKNOWN_OUTCOME = "It may not have gone through. Trying again is safe: it is sent as the same action.";
const CONNECTION = "Could not reach OnboardFlow. Check your connection, or reload the page to sign in again.";

const FIELD_NAMES: Record<string, string> = {
  costCenter: "cost center",
  licenseBundle: "license bundle",
  photoOnFile: "badge photo",
  resolution: "reason",
  reason: "reason",
  note: "note",
  decision: "decision",
  privilegedAccessApproved: "privileged access choice",
  email: "email",
  status: "status filter",
  stage: "stage filter",
  kind: "kind filter",
  department: "department filter",
  limit: "page size",
  cursor: "list position",
};

/** "costCenter" or "it_provisioning" -> "cost center", "it provisioning". */
export function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function stageName(id: string): string {
  return isStageId(id) ? STAGE_BY_ID[id].name : humanize(id);
}

/** The state a conflict message reports ("stage is active" -> "active"). */
function stateIn(message: string): string | null {
  const m = /\b(?:stage|task|approval|blocker|case) is (\w+)/.exec(message);
  return m?.[1] ? humanize(m[1]) : null;
}

function readableInvalid(message: string): string {
  const parts = message
    .split(/;\s*/)
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      const path = i >= 0 ? p.slice(0, i).trim() : "";
      const msg = i >= 0 ? p.slice(i + 1).trim() : p.trim();
      const last = path.split(".").pop() ?? "";
      const field = FIELD_NAMES[last] ?? (last && last !== "body" ? humanize(last) : "request");
      if (field === "request") return "the request was not in the expected form";
      if (/too small|>=\s*1|at least 1|required/i.test(msg)) return `the ${field} is required`;
      if (/too big|<=|at most|too long/i.test(msg)) return `the ${field} is too long`;
      if (/invalid option|expected one of|invalid enum/i.test(msg)) return `the ${field} is not one of the allowed values`;
      return `the ${field} is not valid`;
    });
  const unique = [...new Set(parts)];
  return `${capitalize(unique.length ? unique.join("; ") : "the request was not in the expected form")}.`;
}

/** Describes any thrown value. Mutations (ctx.action set) whose outcome is unknown say that a retry is safe. */
export function describeError(err: unknown, ctx: ErrorContext = {}): DescribedError {
  const mutation = ctx.action !== undefined;
  const retryNext = mutation && outcomeUnknown(err) ? UNKNOWN_OUTCOME : "Try again.";
  if (!(err instanceof ApiError)) {
    return { message: "Something went wrong in the page.", next: mutation ? UNKNOWN_OUTCOME : "Reload the page and try again.", requestId: null };
  }
  const requestId = err.requestId;
  const out = (message: string, next: string | null) => ({ message, next, requestId });
  const subject = ctx.subject;
  switch (err.code) {
    case "network":
      return out(CONNECTION, retryNext);
    case "non_json_response":
      return out(`The server sent an answer OnboardFlow could not read${err.status ? ` (HTTP ${err.status})` : ""}.`, retryNext);
    case "idempotency_in_progress":
      return out("This action is still being processed.", "Wait a moment, then try again: it is sent as the same action.");
    case "idempotency_key_reuse":
      return out("This action was already sent with different details.", "Reload the page and try again.");
    case "idempotency_key_required":
    case "bad_origin":
    case "csrf_header_missing":
      return out("A security check refused the request.", "Reload the page and try again.");
    case "stage_not_blocked": {
      const state = stateIn(err.message);
      return out(`${subject ? capitalize(subject) : "The stage"} is not blocked right now${state ? ` (${state})` : ""}, so there is nothing to retry.`, "If it blocks again, it shows up here with its new round.");
    }
    case "stage_not_started": {
      const m = /the (\w+) stage/.exec(err.message);
      const name = m?.[1] ? stageName(m[1]) : "This stage";
      return out(`${name} has not started yet.`, "Its tasks open when it starts.");
    }
    case "task_not_open": {
      const state = stateIn(err.message);
      return out(`This task is already ${state ?? "closed"}.`, "Nothing more to do.");
    }
    case "approval_not_pending":
      return out("Already decided.", "Nothing more to do.");
    case "blocker_not_open":
      return out("This blocker is already resolved.", "Nothing more to do.");
    case "field_locked_by_approval":
      return out(
        "The license bundle was part of the manager's approval, so it can change only to fix an open license bundle issue.",
        "There is no open license bundle issue for this employee right now; refresh to see the current state.",
      );
    case "field_changed":
      return out("Someone changed this field at the same time.", "Refresh to see the current value, then try again.");
    case "case_finished": {
      const state = stateIn(err.message);
      return out(`This case already ended${state ? ` (${state})` : ""}.`, "There is nothing to terminate.");
    }
    case "restart_conflict":
      return out("The case changed while the restart was being sent.", "Refresh the page, check the case, and try again.");
    case "not_started":
      return out("This case has not started.", "Start it from Cases first.");
    case "not_revision_requested":
      return out("This request is no longer waiting for a resubmission.", "Refresh to see its current round.");
    case "invalid_request":
      return out(readableInvalid(err.message), "Correct it and try again.");
    case "invalid_cursor":
      return out("This list position is no longer valid.", "Reload the page.");
    case "forbidden":
      return out(`You do not have permission to ${ctx.action ?? "see this"}.`, "If you think you should, ask an admin to check your role.");
    case "unauthenticated":
      return out("Your session ended.", "Sign in again.");
    case "not_provisioned":
      return out("This account has no OnboardFlow access.", "Ask an admin to add you.");
    case "not_found":
      return out(`${subject ? capitalize(subject) : "That item"} was not found.`, "It may have been removed; refresh the page.");
    case "workflow_create_failed":
      return out("The onboarding workflow could not be started yet.", mutation ? "Try again in a moment: it is sent as the same action." : "Try again in a moment.");
    case "internal_error":
      return out("Something went wrong on the server.", retryNext);
    default:
      return out(
        `${ctx.action ? `Could not ${ctx.action}` : "Something went wrong"} (HTTP ${err.status}).`,
        mutation && outcomeUnknown(err) ? UNKNOWN_OUTCOME : "Try again; if it keeps happening, give the request id to an admin.",
      );
  }
}

/** The message and next step as one sentence pair. */
export function errorText(err: unknown, ctx: ErrorContext = {}): string {
  const d = describeError(err, ctx);
  return d.next ? `${d.message} ${d.next}` : d.message;
}
