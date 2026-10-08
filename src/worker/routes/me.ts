import { Hono } from "hono";
import type { AppEnv } from "../http.ts";

export function meRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/", (c) => c.json(c.get("principal")));
  return r;
}
