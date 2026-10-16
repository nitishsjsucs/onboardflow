// Rendering harness for web tests: QueryClient, a fixed session, and a memory router.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import type { MeDto } from "../../src/shared/api.ts";
import { StaticSession } from "../../src/web/auth/session.tsx";
import { AnnouncerProvider } from "../../src/web/components/Announcer.tsx";

export const PERSONAS: Record<string, MeDto> = {
  employee: { email: "avery.abara.e001@onboardflow.test", role: "employee", displayName: "Avery Abara", employeeId: "E001" },
  manager: { email: "m01.gray.marlow@onboardflow.test", role: "manager", displayName: "Gray Marlow", staffId: "M01" },
  peopleOps: { email: "c01.x@onboardflow.test", role: "coordinator", displayName: "Coordinator One", staffId: "C01", department: "people_ops" },
  it: { email: "c03.x@onboardflow.test", role: "coordinator", displayName: "Coordinator Three", staffId: "C03", department: "it" },
  admin: { email: "a01.x@onboardflow.test", role: "admin", displayName: "Admin One", staffId: "A01" },
};

/** `client` injects a specific QueryClient (for example createQueryClient(), to test its retry rules); the default never retries. */
export function renderWith(ui: ReactNode, opts: { me: MeDto | null; path?: string; routes?: RouteObject[]; client?: QueryClient }) {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const routes = opts.routes ?? [{ path: "*", element: ui }];
  const router = createMemoryRouter(routes, { initialEntries: [opts.path ?? "/"] });
  const utils = render(
    <QueryClientProvider client={client}>
      <StaticSession me={opts.me}>
        <AnnouncerProvider>
          <RouterProvider router={router} />
        </AnnouncerProvider>
      </StaticSession>
    </QueryClientProvider>,
  );
  return { ...utils, client, router };
}

export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

export type MockResponse = { status?: number; body?: unknown; /** sent as is, not JSON-encoded (a proxy's HTML page, a garbled body) */ raw?: string };

/** A button whose request is in flight: aria-disabled, but not disabled, so it keeps keyboard focus. */
export function isBusy(el: HTMLElement): boolean {
  return el.getAttribute("aria-disabled") === "true" && !(el as HTMLButtonElement).disabled;
}

/** The visually hidden live region's current text. */
export function announced(): string {
  return document.querySelector('[data-testid="announcer"]')?.textContent ?? "";
}

/** Replaces fetch with a router of canned JSON responses; records every call. */
export function mockFetch(handler: (url: string, method: string, body: unknown, signal?: AbortSignal) => MockResponse | Promise<MockResponse>) {
  const calls: FetchCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    const r = await handler(url, method, body, init?.signal ?? undefined);
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200, headers: { "Content-Type": "text/plain" } });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = fn as typeof fetch;
  return calls;
}
