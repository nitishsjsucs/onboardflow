// Live subscriptions are authorized at the WebSocket upgrade (routes/agents.ts),
// but a socket can outlive that decision: the account may be deactivated, lose
// its role, or its Access session may expire. The route passes the subscriber
// (email and token expiry) to the agent in a server-owned header, the agent
// keeps it in the connection's state, and before every state push both agents
// re-check each connection and close the ones that are no longer allowed.
import type { Connection } from "agents";
import { loadPrincipal } from "../auth/middleware.ts";
import type { Principal } from "../http.ts";

/** Set by routes/agents.ts only; a client-supplied copy is stripped before it is set. */
export const SUBSCRIBER_HEADER = "x-onboardflow-subscriber";

export type Subscriber = { email: string; /** Access token expiry, seconds since the epoch (always present: access.ts requires it) */ exp: number };

/** Close codes a client treats as final (4000 + HTTP status). */
export const CLOSE_SESSION_EXPIRED = 4401;
export const CLOSE_REVOKED = 4403;

export function encodeSubscriber(s: Subscriber): string {
  return JSON.stringify(s);
}

export function subscriberFrom(request: Request): Subscriber | null {
  const raw = request.headers.get(SUBSCRIBER_HEADER);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Subscriber>;
    if (typeof v.email !== "string" || v.email.length === 0 || typeof v.exp !== "number") return null;
    return { email: v.email, exp: v.exp };
  } catch {
    return null;
  }
}

/** Stores the subscriber on the connection (called from the agents' onConnect). */
export function rememberSubscriber(connection: Connection, request: Request): void {
  connection.setState({ subscriber: subscriberFrom(request) });
}

/**
 * Closes every connection whose Access token has expired or whose account no
 * longer passes `allowed`. Connections without a recorded subscriber are still
 * in their handshake (onConnect has not stored it yet) and are left alone.
 * Fails closed: a connection whose check throws (for example a D1 error while
 * loading the account) is closed too; the client reconnects and is checked
 * again at the upgrade. Returns the number of connections closed. Never throws.
 */
export async function revokeStaleSubscriptions(
  connections: Iterable<Connection>,
  db: D1Database,
  nowMs: number,
  allowed: (p: Principal) => boolean,
): Promise<number> {
  const principals = new Map<string, Principal | null>();
  let closed = 0;
  for (const connection of connections) {
    try {
      const s = (connection.state as { subscriber?: Subscriber | null } | null)?.subscriber;
      if (!s) continue;
      if (s.exp * 1000 <= nowMs) {
        connection.close(CLOSE_SESSION_EXPIRED, "session expired");
        closed++;
        continue;
      }
      if (!principals.has(s.email)) principals.set(s.email, await loadPrincipal(db, s.email));
      const p = principals.get(s.email) ?? null;
      if (!p || !allowed(p)) {
        connection.close(CLOSE_REVOKED, "subscription no longer allowed");
        closed++;
      }
    } catch (err) {
      console.warn(`subscription check failed, closing the connection: ${err instanceof Error ? err.message : String(err)}`);
      try {
        connection.close(CLOSE_REVOKED, "subscription could not be re-checked");
        closed++;
      } catch {
        // already closed
      }
    }
  }
  return closed;
}
