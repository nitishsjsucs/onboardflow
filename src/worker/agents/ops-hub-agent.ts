// OpsHubAgent: the singleton ("global") behind the live dashboard. It is
// reconcile-only: caseChanged marks it dirty and schedules a debounced
// reconcile that recomputes every aggregate from D1 in one batch. It keeps no
// incremental arithmetic, because integration health, incidents and recent
// activity cannot be derived from case summaries, and summaries from 150
// agents arrive out of order. asOfSeq stops an older read from overwriting a
// newer one. Subscribers are coordinators and admins, read-only (ADR 0006).
import { Agent, type Connection, type ConnectionContext } from "agents";
import { canSubscribe } from "../auth/policy.ts";
import type { HubState } from "../../shared/agent-state.ts";
import { parseConfig } from "../config.ts";
import { loadClock } from "../db/clock.ts";
import { errorMessage } from "../integrations/errors.ts";
import { computeHubDomain, emptyHubState } from "./projection.ts";
import { Serial } from "./serial.ts";
import { rememberSubscriber, revokeStaleSubscriptions } from "./subscriptions.ts";

export const HUB_NAME = "global";

/**
 * The Agents SDK stores schedule times in whole seconds, rounded down, so `schedule(1, ...)` can fire
 * anywhere from a few milliseconds to one second later. A debounce must wait at least its window,
 * so round the target time up to the next whole second instead (the window becomes [s, s + 1) seconds).
 */
export function notBefore(nowMs: number, seconds: number): Date {
  return new Date(Math.ceil((nowMs + seconds * 1000) / 1000) * 1000);
}
export const HUB_SAFETY_INTERVAL_S = 60;

export class OpsHubAgent extends Agent<Env, HubState> {
  override initialState: HubState = emptyHubState();
  readonly #serial = new Serial();

  override async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS hub_meta (id INTEGER PRIMARY KEY CHECK (id = 1), dirty INTEGER NOT NULL DEFAULT 0, debounce_pending INTEGER NOT NULL DEFAULT 0, last_case TEXT, last_seq INTEGER)`;
    this.sql`INSERT OR IGNORE INTO hub_meta (id, dirty, debounce_pending) VALUES (1, 0, 0)`;
    // Safety net: reconcile periodically even if a notification was lost (idempotent).
    await this.scheduleEvery(HUB_SAFETY_INTERVAL_S, "reconcile");
  }

  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  // Remember who subscribed, so later state pushes can re-check them (agents/subscriptions.ts).
  override onConnect(connection: Connection, ctx: ConnectionContext): void {
    rememberSubscriber(connection, ctx.request);
  }

  /** Closes live subscriptions whose session expired or whose account may no longer see the dashboard. */
  async revokeStaleSubscriptions(): Promise<number> {
    const connections = [...this.getConnections()];
    if (connections.length === 0) return 0;
    return revokeStaleSubscriptions(connections, this.env.DB, Date.now(), (p) => canSubscribe(p, "OPS_HUB_AGENT", HUB_NAME));
  }

  // OnboardFlow uses no sub-agents: refuse every `/sub/<class>/<name>` facet
  // request, so no client can create a facet (defense in depth behind the
  // path check in routes/agents.ts).
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  override validateStateChange(_next: HubState, source: unknown): void {
    if (source !== "server") throw new Error("OpsHubAgent state is read-only for clients");
  }

  /** Called by CaseAgents after they refresh. Marks the hub dirty and debounces one reconcile. */
  async caseChanged(employeeId: string, asOfSeq: number): Promise<void> {
    this.sql`UPDATE hub_meta SET dirty = 1, last_case = ${employeeId}, last_seq = ${asOfSeq} WHERE id = 1`;
    const pending = this.sql<{ debounce_pending: number }>`SELECT debounce_pending FROM hub_meta WHERE id = 1`[0]?.debounce_pending ?? 0;
    if (pending) return;
    this.sql`UPDATE hub_meta SET debounce_pending = 1 WHERE id = 1`;
    await this.schedule(notBefore(Date.now(), parseConfig(this.env).hubDebounceS), "reconcile");
  }

  /** Recomputes the dashboard from D1 (serialized); applies it unless older than the current state. */
  async reconcile(): Promise<HubState> {
    return this.#serial.run(async () => {
      try {
        this.sql`UPDATE hub_meta SET dirty = 0, debounce_pending = 0 WHERE id = 1`;
        const clock = await loadClock(parseConfig(this.env), this.env.DB);
        const { domain, asOfSeq } = await computeHubDomain(this.env.DB, clock.nowIso());
        const current = this.state;
        // before pushing new state (and at least every minute): drop subscribers that may no longer see it
        await this.revokeStaleSubscriptions();
        if (!current || asOfSeq >= current.asOfSeq) {
          this.setState({ ...domain, asOfSeq, reconciledAt: clock.nowIso(), version: (current?.version ?? 0) + 1 });
        }
      } catch (err) {
        console.error(`hub reconcile: ${errorMessage(err)}`);
      }
      return this.state;
    });
  }

  meta(): { dirty: number; debounce_pending: number } {
    return this.sql<{ dirty: number; debounce_pending: number }>`SELECT dirty, debounce_pending FROM hub_meta WHERE id = 1`[0] ?? { dirty: 0, debounce_pending: 0 };
  }

  getSnapshot(): HubState {
    return this.state;
  }

  /** Eval hook: drop the object; the next call re-wakes it with persisted state intact. */
  devEvict(): void {
    this.ctx.abort("eval-evict");
  }
}
