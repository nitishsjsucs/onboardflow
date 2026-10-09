// /agents/* (SPEC 10.3): WebSocket subscriptions to CaseAgent and OpsHubAgent
// state, behind the same Access middleware as /api. onBeforeConnect enforces
// Origin (upgrades bypass CORS), valid names (no arbitrary Durable Object can
// be created) and canSubscribe; onBeforeRequest refuses plain HTTP. The
// connections themselves are read-only (ADR 0006).
//
// Two SDK features would bypass those checks, so they are closed here:
// * Agent.fetch turns any `/agents/<class>/<name>/sub/<child>/<childName>`
//   tail into a sub-agent facet created on demand. Only exactly
//   `/agents/<class>/<name>` is accepted.
// * The SDK trusts internal headers on the forwarded request
//   (`x-cf-agents-subagent-url` attaches the socket to a facet without
//   running onBeforeSubAgent; `x-agents-lifecycle-props` sets startup props).
//   The request forwarded to the Durable Object is rebuilt without any
//   `x-cf-agents-*` or `x-agents-*` header.
// Both agent classes also refuse sub-agents in onBeforeSubAgent.
//
// The subscription is re-checked later as well: the forwarded request carries
// the subscriber (email, token expiry), and each agent closes sockets whose
// session expired or whose account no longer passes canSubscribe before it
// pushes new state (agents/subscriptions.ts).
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { EMPLOYEE_ID_PATTERN } from "../../shared/ids.ts";
import { HUB_NAME } from "../agents/ops-hub-agent.ts";
import { encodeSubscriber, SUBSCRIBER_HEADER, type Subscriber } from "../agents/subscriptions.ts";
import { canSubscribe } from "../auth/policy.ts";
import { apiError, type AppEnv } from "../http.ts";

const AGENT_PATH_SEGMENTS = 3; // "agents", class, name

function isInternalAgentHeader(name: string): boolean {
  const h = name.toLowerCase();
  return h.startsWith("x-cf-agents-") || h.startsWith("x-agents-");
}

/**
 * The request forwarded to the agent: without SDK-internal headers a client
 * could forge, and with the server-owned subscriber header (email and token
 * expiry) the agent re-checks before every state push.
 */
export function sanitizedAgentRequest(request: Request, subscriber: Subscriber): Request {
  const clean = new Request(request);
  for (const name of [...clean.headers.keys()]) if (isInternalAgentHeader(name) || name.toLowerCase() === SUBSCRIBER_HEADER) clean.headers.delete(name);
  clean.headers.set(SUBSCRIBER_HEADER, encodeSubscriber(subscriber));
  return clean;
}

function forbidden(reason: string): Response {
  return new Response(JSON.stringify({ error: { code: "forbidden", message: reason } }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export function agentRoutes() {
  const r = new Hono<AppEnv>();
  r.all("/*", async (c) => {
    const principal = c.get("principal");
    const subscriber: Subscriber = { email: principal.email, exp: c.get("tokenExp") };
    const res = await routeAgentRequest(c.req.raw, c.env, {
      onBeforeRequest: () => forbidden("agents are reachable only through a WebSocket upgrade"),
      onBeforeConnect: async (request, route) => {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin");
        if (!origin || origin !== url.origin) return forbidden("bad origin");
        if (url.pathname.split("/").filter(Boolean).length !== AGENT_PATH_SEGMENTS) return forbidden("sub-agent paths are not allowed");
        if (route.className === "CASE_AGENT") {
          if (!EMPLOYEE_ID_PATTERN.test(route.name)) return forbidden("invalid case name");
          const emp = await c.env.DB.prepare("SELECT id, manager_id FROM employees WHERE id = ?").bind(route.name).first<{ id: string; manager_id: string }>();
          if (!emp) return forbidden("unknown case");
          if (!canSubscribe(principal, route.className, route.name, { employeeId: emp.id, managerId: emp.manager_id })) return forbidden("not allowed");
          return sanitizedAgentRequest(request, subscriber);
        }
        if (route.className === "OPS_HUB_AGENT") {
          if (route.name !== HUB_NAME || !canSubscribe(principal, route.className, route.name)) return forbidden("not allowed");
          return sanitizedAgentRequest(request, subscriber);
        }
        return forbidden("unknown agent");
      },
    });
    return res ?? apiError(c, 404, "not_found", "unknown agent route");
  });
  return r;
}
