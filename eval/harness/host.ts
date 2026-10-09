// Host stall detector. Eval timeouts and chaos deadlines are wall-clock, so
// a run during which the machine slept (a closed lid on battery) or the
// harness process froze reports timeouts the system never caused. A 1 s
// interval timer measures the gap between its ticks; wall-clock time keeps
// running while the machine sleeps, so a sleep shows up as one long gap.
// Every run records the result, and the README flags a run that stalled.

/** Gaps beyond the tick interval longer than this count as a stall. */
export const STALL_THRESHOLD_MS = 5_000;

export type HostStalls = { stalls: number; stalledMs: number; longestMs: number };

/** Summarizes the extra delay of each tick (gap minus the interval). */
export function summarizeGaps(extraMs: readonly number[], thresholdMs = STALL_THRESHOLD_MS): HostStalls {
  const stalls = extraMs.filter((g) => g > thresholdMs);
  return { stalls: stalls.length, stalledMs: stalls.reduce((a, b) => a + b, 0), longestMs: stalls.length === 0 ? 0 : Math.max(...stalls) };
}

/** Starts watching; `stop()` returns the stalls seen since. The timer never keeps the process alive. */
export function watchHost(intervalMs = 1_000, now: () => number = Date.now): { stop: () => HostStalls } {
  let last = now();
  const extra: number[] = [];
  const timer = setInterval(() => {
    const t = now();
    extra.push(t - last - intervalMs);
    last = t;
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      extra.push(now() - last - intervalMs);
      return summarizeGaps(extra);
    },
  };
}

export function mergeStalls(list: readonly HostStalls[]): HostStalls {
  return {
    stalls: list.reduce((a, s) => a + s.stalls, 0),
    stalledMs: list.reduce((a, s) => a + s.stalledMs, 0),
    longestMs: list.reduce((a, s) => Math.max(a, s.longestMs), 0),
  };
}
