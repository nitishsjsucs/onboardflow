import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeStalls, STALL_THRESHOLD_MS, summarizeGaps, watchHost } from "../../eval/harness/host.ts";
import { describeStalls } from "../../eval/harness/report.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("host stall detector", () => {
  it("counts only gaps beyond the threshold", () => {
    expect(summarizeGaps([0, 3, 4_999, 5_001, 975_000])).toEqual({ stalls: 2, stalledMs: 980_001, longestMs: 975_000 });
    expect(summarizeGaps([])).toEqual({ stalls: 0, stalledMs: 0, longestMs: 0 });
    expect(STALL_THRESHOLD_MS).toBe(5_000);
  });

  it("sees a system sleep as one long tick, because wall-clock time runs on while the machine sleeps", () => {
    vi.useFakeTimers();
    const w = watchHost(1_000);
    vi.advanceTimersByTime(10_000);
    vi.setSystemTime(Date.now() + 900_000); // the lid closes for 15 minutes
    vi.advanceTimersByTime(3_000);
    expect(w.stop()).toEqual({ stalls: 1, stalledMs: 900_000, longestMs: 900_000 });
  });

  it("reports none for a quiet run", () => {
    vi.useFakeTimers();
    const w = watchHost(1_000);
    vi.advanceTimersByTime(60_000);
    expect(w.stop()).toEqual({ stalls: 0, stalledMs: 0, longestMs: 0 });
  });

  it("merges per-seed stalls and describes them for the README", () => {
    const merged = mergeStalls([
      { stalls: 0, stalledMs: 0, longestMs: 0 },
      { stalls: 2, stalledMs: 1_880_000, longestMs: 984_000 },
    ]);
    expect(merged).toEqual({ stalls: 2, stalledMs: 1_880_000, longestMs: 984_000 });
    expect(describeStalls({ stalls: 0, stalledMs: 0, longestMs: 0 })).toBe("none");
    expect(describeStalls(merged)).toBe("2 (1880 s in total, longest 984 s): wall-clock timeouts and deadlines in this run are not reliable");
  });
});
