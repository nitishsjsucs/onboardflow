// Clock seam. Production uses the system clock. With SIM_CLOCK=on (eval runs
// and tests only) the offset in D1 sim_clock is added, so overdue approvals and
// tasks are reachable without waiting days. Production never reads sim_clock.
import type { AppConfig } from "../config.ts";

export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

export class OffsetClock implements Clock {
  readonly offsetMs: number;
  constructor(offsetMs: number) {
    this.offsetMs = offsetMs;
  }
  nowMs(): number {
    return Date.now() + this.offsetMs;
  }
  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

export async function loadClock(config: Pick<AppConfig, "simClock">, db: D1Database): Promise<Clock> {
  if (!config.simClock) return new SystemClock();
  const row = await db.prepare("SELECT offset_ms FROM sim_clock WHERE id = 1").first<{ offset_ms: number }>();
  return new OffsetClock(row?.offset_ms ?? 0);
}
