// Rendering harness for web tests: QueryClient, a fixed session, and a memory router.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import type { MeDto } from "../../src/shared/api.ts";
import { StaticSession } from "../../src/web/auth/session.tsx";

export const PERSONAS: Record<string, MeDto> = {
  employee: { email: "avery.abara.e001@onboardflow.test", role: "employee", displayName: "Avery Abara", employeeId: "E001" },
  manager: { email: "m01.gray.marlow@onboardflow.test", role: "manager", displayName: "Gray Marlow", staffId: "M01" },
  peopleOps: { email: "c01.x@onboardflow.test", role: "coordinator", displayName: "Coordinator One", staffId: "C01", department: "people_ops" },
  it: { email: "c03.x@onboardflow.test", role: "coordinator", displayName: "Coordinator Three", staffId: "C03", department: "it" },
  admin: { email: "a01.x@onboardflow.test", role: "admin", displayName: "Admin One", staffId: "A01" },
};

export function renderWith(ui: ReactNode, opts: { me: MeDto | null; path?: string; routes?: RouteObject[] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const routes = opts.routes ?? [{ path: "*", element: ui }];
  const router = createMemoryRouter(routes, { initialEntries: [opts.path ?? "/"] });
  const utils = render(
    <QueryClientProvider client={client}>
      <StaticSession me={opts.me}>
        <RouterProvider router={router} />
      </StaticSession>
    </QueryClientProvider>,
  );
  return { ...utils, client, router };
}

export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Replaces fetch with a router of canned JSON responses; records every call. */
export function mockFetch(handler: (url: string, method: string, body: unknown) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    const r = await handler(url, method, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = fn as typeof fetch;
  return calls;
}
