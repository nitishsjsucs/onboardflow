// Shared Hono context types and the error envelope for every route.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Department, Role } from "../shared/roles.ts";
import type { AppConfig } from "./config.ts";
import type { Clock } from "./db/clock.ts";

export type Principal = {
  email: string;
  role: Role;
  displayName: string;
  employeeId?: string;
  staffId?: string;
  department?: Department;
};

export type AppVariables = {
  requestId: string;
  config: AppConfig;
  clock: Clock;
  principal: Principal;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppEnv>;

export type ErrorBody = { error: { code: string; message: string; requestId: string } };

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const body: ErrorBody = { error: { code, message, requestId } };
  return c.json(body, status, headers);
}
