// Hono app composition. Middleware order (SPEC Section 9):
//   request id -> config (fails closed) -> clock -> dev host guard
//   -> /dev (dev only, same-origin on mutations)
//   -> /api: health (public), Access JWT -> principal -> same-origin
//      -> Idempotency-Key present on mutations -> route role gate -> resource policy
//      -> zod validation -> idempotent command
import { Hono } from "hono";
import { devRoutes } from "./auth/dev.ts";
import { requireSameOrigin } from "./auth/csrf.ts";
import { requireUser } from "./auth/middleware.ts";
import { ConfigError, parseConfig } from "./config.ts";
import { loadClock } from "./db/clock.ts";
import { apiError, type AppEnv } from "./http.ts";
import { agentRoutes } from "./routes/agents.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { auditRoutes } from "./routes/audit.ts";
import { blockerRoutes } from "./routes/blockers.ts";
import { caseRoutes } from "./routes/cases.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { employeeRoutes } from "./routes/employees.ts";
import { followupRoutes } from "./routes/followups.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { meRoutes } from "./routes/me.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { requireIdempotencyKey } from "./routes/util.ts";
import { simApp } from "./sims/app.ts";

export const APP_VERSION = "1.0.0";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const GUARDED_PREFIXES = ["/api/", "/agents/", "/dev/"];

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    try {
      c.set("config", parseConfig(c.env));
    } catch (err) {
      if (err instanceof ConfigError) return apiError(c, 500, err.code, err.message);
      throw err;
    }
    return next();
  });

  // Dev auth is only ever served to a local host (SPEC 5.2 guard 1).
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const guarded = GUARDED_PREFIXES.some((p) => url.pathname.startsWith(p) || url.pathname === p.slice(0, -1));
    if (guarded && c.get("config").authMode === "dev" && !LOCAL_HOSTS.has(url.hostname)) {
      return apiError(c, 500, "dev_auth_on_public_host", "AUTH_MODE=dev is only served on localhost");
    }
    c.set("clock", await loadClock(c.get("config"), c.env.DB));
    return next();
  });

  // /dev/* exists only in dev mode.
  app.use("/dev/*", async (c, next) => {
    if (c.get("config").authMode !== "dev") return apiError(c, 404, "not_found", "not found");
    return next();
  });
  app.use("/dev/*", requireSameOrigin);
  app.route("/dev", devRoutes());

  // Simulated HR, IT and Facilities systems, protected by X-Sim-Api-Key.
  app.route("/sim", simApp());

  app.get("/api/health", (c) => c.json({ ok: true, authMode: c.get("config").authMode, version: APP_VERSION }));

  // Live state subscriptions: same Access middleware, then origin + policy checks per upgrade.
  app.use("/agents/*", requireUser);
  app.route("/agents", agentRoutes());

  app.use("/api/*", requireUser);
  app.use("/api/*", requireSameOrigin);
  app.use("/api/*", requireIdempotencyKey);
  app.route("/api/me", meRoutes());
  app.route("/api/employees", employeeRoutes());
  app.route("/api/cases", caseRoutes());
  app.route("/api/tasks", taskRoutes());
  app.route("/api/approvals", approvalRoutes());
  app.route("/api/blockers", blockerRoutes());
  app.route("/api/followups", followupRoutes());
  app.route("/api/dashboard", dashboardRoutes());
  app.route("/api/integrations", integrationRoutes());
  app.route("/api/audit", auditRoutes());

  app.notFound((c) => apiError(c, 404, "not_found", "not found"));
  app.onError((err, c) => {
    console.error("unhandled error", err);
    return apiError(c, 500, "internal_error", err instanceof Error ? err.message : "internal error");
  });

  return app;
}

export const app = createApp();
