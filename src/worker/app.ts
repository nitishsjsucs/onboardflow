import { Hono } from "hono";

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>();

  app.get("/api/health", (c) =>
    c.json({ ok: true, authMode: c.env.AUTH_MODE, version: "1.0.0" }),
  );

  return app;
}

export const app = createApp();
