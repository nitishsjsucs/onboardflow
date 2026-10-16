// How many recovery rounds a blocked operation stage has used, out of the
// configured limit, in words. The workflow fails the case when a stage's round
// that reaches MAX_STAGE_ROUNDS fails (stage-runner.ts: roundsUsed = round -
// roundBase + 1), and every Retry of a stage still blocked on the same cause
// spends one, so the queue says so before the click.
//
// "At most" because a second, run-wide cap (MAX_RECOVERY_ROUNDS, counted in
// the workflow's memory across all stages of one run) can end the case sooner.
// The limits come from GET /api/me (coordinators and admins); with EVAL_HOOKS
// on, an instance may run with limits from its start event, which this cannot
// see, so in eval runs the readout shows the configured ones.
import type { IntegrationCallView } from "../../shared/api.ts";
import type { StageStatus } from "../../shared/domain.ts";
import { SYSTEM_NAMES } from "./blocker-text.ts";
import { formatInstant } from "./dates.ts";

export type RoundsReadout = {
  used: number;
  /** Rounds left after the used ones; the stage fails the case if round `max` fails. */
  left: number;
  max: number;
  /** The round a Retry now would run. */
  next: number;
  running: boolean;
  /** The next Retry is the last one. */
  lastRetry: boolean;
  text: string;
};

/**
 * The readout for a stage, or null when there is nothing to say (no limits, a stage that is neither blocked
 * nor running, a round below its base). `roundBase` is 1, except for closeout: its recovery rounds count from
 * the round its sign-off was approved in (approval-loop.ts).
 */
export function roundsReadout(i: { stageStatus: StageStatus | null; stageRound: number | null; roundBase?: number; maxStageRounds: number | undefined }): RoundsReadout | null {
  if (!i.maxStageRounds || i.stageRound === null) return null;
  const max = i.maxStageRounds;
  const used = i.stageRound - (i.roundBase ?? 1) + 1;
  if (used < 1) return null;
  if (i.stageStatus === "active") return { used, left: Math.max(0, max - used), max, next: used, running: true, lastRetry: false, text: `Round ${used} of ${max} running.` };
  if (i.stageStatus !== "blocked") return null;
  const left = Math.max(0, max - used);
  const text =
    left >= 2
      ? `Round ${used} of ${max} used on this stage. At most ${left} more retries: if round ${max} fails, the workflow fails the case.`
      : left === 1
        ? `Round ${used} of ${max} used. The next retry is the last: if round ${max} fails, the workflow fails the case.`
        : `Round ${used} of ${max} used: no retry is left.`;
  return { used, left, max, next: used + 1, running: false, lastRetry: left === 1, text };
}

/** The round closeout's recovery rounds count from: the highest approved sign-off round (null before one). */
export function closeoutRoundBase(approvals: ReadonlyArray<{ checkpoint: string; status: string; round: number }>): number | null {
  const rounds = approvals.filter((a) => a.checkpoint === "closeout" && a.status === "approved").map((a) => a.round);
  return rounds.length > 0 ? Math.max(...rounds) : null;
}

// ---------------------------------------------------------------------------
// A stage's attempts, from the case's integration call log
// ---------------------------------------------------------------------------

export const OUTCOME_WORDS: Record<IntegrationCallView["outcome"], string> = {
  ok: "ok",
  replayed: "replayed",
  retryable_error: "failed",
  fatal_error: "rejected",
  timeout: "timed out",
  malformed: "unreadable answer",
  conflict: "conflict",
};

export const isFailure = (c: Pick<IntegrationCallView, "outcome">) => c.outcome !== "ok" && c.outcome !== "replayed";

/** The round in a step name: "it_provisioning.it.create-account#r2" and "...poll-it_device#r2.3" are round 2. */
export function roundOfStep(stepName: string): number | null {
  const m = /#r(\d+)/.exec(stepName);
  return m ? Number(m[1]) : null;
}

/**
 * The stage's calls in the latest run seen, grouped by round (step names start with "<stage>."), and the
 * latest round's calls in the order they were made.
 */
export function stageAttempts(calls: readonly IntegrationCallView[], stageId: string): { runNo: number; round: number; calls: IntegrationCallView[] } | null {
  const mine = calls.filter((c) => c.stepName.startsWith(`${stageId}.`) && roundOfStep(c.stepName) !== null);
  if (mine.length === 0) return null;
  const runNo = Math.max(...mine.map((c) => c.runNo));
  const inRun = mine.filter((c) => c.runNo === runNo);
  const round = Math.max(...inRun.map((c) => roundOfStep(c.stepName)!));
  return { runNo, round, calls: inRun.filter((c) => roundOfStep(c.stepName) === round) };
}

/** "Round 2: 5 attempts, all failed with HTTP 503 from IT (simulated); last Oct 8, 12:00." */
export function attemptsSentence(round: number, calls: readonly IntegrationCallView[]): string {
  const n = calls.length;
  const attempts = n === 1 ? "1 attempt" : `${n} attempts`;
  const last = calls.reduce((a, c) => (c.createdAt > a ? c.createdAt : a), "");
  const when = last ? `; last ${formatInstant(last)}` : "";
  const failed = calls.filter(isFailure);
  if (failed.length === 0) return `Round ${round}: ${attempts}, all ok${when}.`;
  if (failed.length < n) return `Round ${round}: ${attempts}, ${n - failed.length} ok, ${failed.length} failed${when}.`;
  const statuses = new Set(failed.map((c) => c.httpStatus));
  const systems = new Set(failed.map((c) => c.system));
  const status = statuses.size === 1 ? [...statuses][0] : null;
  const from = systems.size === 1 ? ` from ${SYSTEM_NAMES[[...systems][0]!]} (simulated)` : "";
  return `Round ${round}: ${attempts}, all failed${status ? ` with HTTP ${status}${from}` : ""}${when}.`;
}
