// /agents/* (SPEC 10.3): WebSocket subscriptions to CaseAgent and OpsHubAgent
// state, behind the same Access middleware as /api. onBeforeConnect enforces
// Origin (upgrades bypass CORS), valid names (no arbitrary Durable Object can
// be created) and canSubscribe; onBeforeRequest refuses plain HTTP. The
// connections themselves are read-only (ADR 0006).
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { EMPLOYEE_ID_PATTERN } from "../../shared/ids.ts";
import { HUB_NAME } from "../agents/ops-hub-agent.ts";
import { canSubscribe } from "../auth/policy.ts";
import { apiError, type AppEnv } from "../http.ts";

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
    const res = await routeAgentRequest(c.req.raw, c.env, {
      onBeforeRequest: () => forbidden("agents are reachable only through a WebSocket upgrade"),
      onBeforeConnect: async (request, route) => {
        const origin = request.headers.get("Origin");
        if (!origin || origin !== new URL(request.url).origin) return forbidden("bad origin");
        if (route.className === "CASE_AGENT") {
          if (!EMPLOYEE_ID_PATTERN.test(route.name)) return forbidden("invalid case name");
          const emp = await c.env.DB.prepare("SELECT id, manager_id FROM employees WHERE id = ?").bind(route.name).first<{ id: string; manager_id: string }>();
          if (!emp) return forbidden("unknown case");
          if (!canSubscribe(principal, route.className, route.name, { employeeId: emp.id, managerId: emp.manager_id })) return forbidden("not allowed");
          return undefined;
        }
        if (route.className === "OPS_HUB_AGENT") {
          if (route.name !== HUB_NAME || !canSubscribe(principal, route.className, route.name)) return forbidden("not allowed");
          return undefined;
        }
        return forbidden("unknown agent");
      },
    });
    return res ?? apiError(c, 404, "not_found", "unknown agent route");
  });
  return r;
}
