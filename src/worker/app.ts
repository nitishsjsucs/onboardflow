// Hono app composition. Middleware order (SPEC Section 9):
//   request id -> config (fails closed) -> clock -> dev host guard
//   -> /dev (dev only, same-origin on mutations)
//   -> /api: health (public), Access JWT -> principal -> same-origin -> routes
import { Hono } from "hono";
import { devRoutes } from "./auth/dev.ts";
import { requireSameOrigin } from "./auth/csrf.ts";
import { requireUser } from "./auth/middleware.ts";
import { ConfigError, parseConfig } from "./config.ts";
import { loadClock } from "./db/clock.ts";
import { apiError, type AppEnv } from "./http.ts";
import { meRoutes } from "./routes/me.ts";

export const APP_VERSION = "1.0.0";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const GUARDED_PREFIXES = ["/api/", "/agents/", "/dev/"];

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
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

  app.get("/api/health", (c) => c.json({ ok: true, authMode: c.get("config").authMode, version: APP_VERSION }));

  app.use("/api/*", requireUser);
  app.use("/api/*", requireSameOrigin);
  app.route("/api/me", meRoutes());

  app.notFound((c) => apiError(c, 404, "not_found", "not found"));
  app.onError((err, c) => {
    console.error("unhandled error", err);
    return apiError(c, 500, "internal_error", err instanceof Error ? err.message : "internal error");
  });

  return app;
}

export const app = createApp();
