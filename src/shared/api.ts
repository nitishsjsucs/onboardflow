// HTTP API contract shared by the worker, the web client and the tests:
// the route registry (every /api route with the roles that may call it) and,
// as routes land, their zod request schemas and response DTO types.
import { z } from "zod";
import type { Department, Role } from "./roles.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type RouteDef = {
  id: string;
  method: HttpMethod;
  path: string;
  /** "public" needs no token; otherwise the roles that may pass the role gate (resource policy may narrow further). */
  roles: "public" | readonly Role[];
};

const ALL: readonly Role[] = ["employee", "manager", "coordinator", "admin"];

export const API_ROUTES = [
  { id: "health", method: "GET", path: "/api/health", roles: "public" },
  { id: "me", method: "GET", path: "/api/me", roles: ALL },
] as const satisfies readonly RouteDef[];

export type RouteId = (typeof API_ROUTES)[number]["id"];

export const Me = z.object({
  email: z.string(),
  role: z.enum(["employee", "manager", "coordinator", "admin"]),
  displayName: z.string(),
  employeeId: z.string().optional(),
  staffId: z.string().optional(),
  department: z.enum(["people_ops", "it", "facilities"]).optional(),
});
export type MeDto = z.infer<typeof Me> & { department?: Department };

export const Health = z.object({ ok: z.literal(true), authMode: z.enum(["access", "dev"]), version: z.string() });

export type ErrorEnvelope = { error: { code: string; message: string; requestId: string } };

export type Page<T> = { items: T[]; nextCursor: string | null };
