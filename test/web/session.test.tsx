import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeDto } from "../../src/shared/api.ts";
import { actionKeys } from "../../src/web/api/action-keys.ts";
import { createQueryClient } from "../../src/web/api/query-client.ts";
import { safeNext } from "../../src/web/auth/next.ts";
import { SessionProvider } from "../../src/web/auth/session.tsx";
import { AnnouncerProvider } from "../../src/web/components/Announcer.tsx";
import { routes } from "../../src/web/router.tsx";
import { blocker, caseDetail } from "./fixtures.ts";
import { type MockResponse, mockFetch, PERSONAS } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

const PERSONA_LIST = [
  { email: PERSONAS.peopleOps!.email, role: "coordinator", label: "People Ops coordinator" },
  { email: PERSONAS.employee!.email, role: "employee", label: "Employee E001" },
];

/** The real app: SessionProvider over /api/me, the production QueryClient, the route table in a memory router. */
function renderApp(path: string) {
  const client = createQueryClient({ retryDelay: 0 });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <AnnouncerProvider>
          <RouterProvider router={router} />
        </AnnouncerProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { client, router };
}

/** A server with a signed-in persona (null = signed out) in dev or Access mode; `extra` answers anything else. */
function server(opts: { me: MeDto | null; authMode?: "dev" | "access"; extra?: (url: string, method: string) => MockResponse | undefined }) {
  let me = opts.me;
  const calls = mockFetch((url, method, body) => {
    if (url === "/api/health") return { body: { ok: true, authMode: opts.authMode ?? "dev", version: "1.0.0" } };
    if (url === "/api/me") return me ? { body: me } : { status: 401, body: { error: { code: "unauthenticated", message: "missing token", requestId: "r-me" } } };
    if (url === "/dev/personas") return { body: PERSONA_LIST };
    if (url === "/dev/login") {
      me = Object.values(PERSONAS).find((p) => p.email === (body as { email: string }).email) ?? null;
      return { body: { token: "t" } };
    }
    if (url === "/dev/logout") {
      me = null;
      return { body: { ok: true } };
    }
    const r = opts.extra?.(url, method);
    if (r) return r;
    if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
    if (url.startsWith("/api/cases/")) return { body: caseDetail(null) };
    return { body: { items: [], nextCursor: null } };
  });
  return {
    calls,
    expire: () => {
      me = null;
    },
  };
}

describe("safeNext", () => {
  const ops = PERSONAS.peopleOps!;
  it.each(["//evil.example", "https://evil.example", "/\\evil", "/login", "/login?next=/queue", "/%09/evil", "/\t/evil.example", "javascript:alert(1)", "/audit"])("rejects %j for People Ops", (next) => {
    expect(safeNext(next, ops)).toBe("/queue");
  });

  it("accepts a page the role can open, with its query string", () => {
    expect(safeNext("/cases/E002", ops)).toBe("/cases/E002");
    expect(safeNext("/queue?kind=approval_overdue", ops)).toBe("/queue?kind=approval_overdue");
    expect(safeNext("/approvals", ops)).toBe("/approvals");
    // an IT coordinator cannot open /approvals, and an employee only their own case
    expect(safeNext("/approvals", PERSONAS.it!)).toBe("/queue");
    expect(safeNext("/cases/E001", PERSONAS.employee!)).toBe("/cases/E001");
    expect(safeNext("/cases/E002", PERSONAS.employee!)).toBe("/me");
    expect(safeNext(null, PERSONAS.admin!)).toBe("/dashboard");
  });
});

describe("sign in keeps the deep link", () => {
  it("signed out, /cases/E002 goes to the login page and back to /cases/E002 after picking People Ops", async () => {
    server({ me: null });
    const { router } = renderApp("/cases/E002");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2Fcases%2FE002");
    fireEvent.click(await screen.findByRole("button", { name: /People Ops coordinator/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/cases/E002"));
    await screen.findByRole("heading", { name: /Avery Abara/ });
  });

  it("ignores an unsafe next and lands on the role's home", async () => {
    server({ me: null });
    const { router } = renderApp("/login?next=%2F%2Fevil.example");
    fireEvent.click(await screen.findByRole("button", { name: /People Ops coordinator/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/queue"));
  });
});

describe("switch persona and sign out", () => {
  it("dev: Switch persona posts /dev/logout with X-OnboardFlow, clears the cache and the action keys, and lands on /login", async () => {
    const { calls } = server({ me: PERSONAS.peopleOps!, authMode: "dev" });
    const { client, router } = renderApp("/cases/E002");
    await screen.findByRole("heading", { name: /Avery Abara/ });
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
    actionKeys.keyFor("someAction");
    fireEvent.click(await screen.findByRole("button", { name: "Switch persona" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    const logout = calls.find((c) => c.url === "/dev/logout")!;
    expect(logout.method).toBe("POST");
    expect(logout.headers["X-OnboardFlow"]).toBe("1");
    expect(actionKeys.pending).toBe(0);
    // nothing of the previous persona is cached: only the (now empty) session remains
    expect(client.getQueryData(["case", "E002"])).toBeUndefined();
    expect(client.getQueryCache().findAll().map((q) => q.queryKey[0])).not.toContain("case");
    expect(client.getQueryData(["me"])).toBeNull();
    // the next persona's pages make fresh requests
    const before = calls.filter((c) => c.url === "/api/cases/E002").length;
    fireEvent.click(await screen.findByRole("button", { name: /People Ops coordinator/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/queue"));
    await router.navigate("/cases/E002");
    await screen.findByRole("heading", { name: /Avery Abara/ });
    expect(calls.filter((c) => c.url === "/api/cases/E002").length).toBe(before + 1);
  });

  it("Access: shows Sign out to /cdn-cgi/access/logout and no persona switch", async () => {
    server({ me: PERSONAS.peopleOps!, authMode: "access" });
    renderApp("/queue");
    const signOut = await screen.findByRole("link", { name: "Sign out" });
    expect(signOut.getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(screen.queryByRole("button", { name: "Switch persona" })).toBeNull();
  });
});

describe("an ended session", () => {
  it("a 401 on a query after sign in says the session ended, with a sign-in link back to this page", async () => {
    const s = server({ me: PERSONAS.peopleOps!, authMode: "dev" });
    const { client } = renderApp("/cases/E002");
    await screen.findByRole("heading", { name: /Avery Abara/ });
    s.expire();
    server({
      me: PERSONAS.peopleOps!,
      extra: (url) => (url.startsWith("/api/cases") ? { status: 401, body: { error: { code: "unauthenticated", message: "token expired", requestId: "r1" } } } : undefined),
    });
    await client.refetchQueries({ queryKey: ["case"] }).catch(() => undefined);
    const banner = (await screen.findByText("Your session ended.")).closest("[role=alert]") as HTMLElement;
    expect(within(banner).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login?next=%2Fcases%2FE002");
  });

  it("a 401 on a mutation says the same, and Access mode offers a reload", async () => {
    server({
      me: PERSONAS.it!,
      authMode: "access",
      extra: (url, method) => {
        if (method === "POST") return { status: 401, body: { error: { code: "unauthenticated", message: "token expired", requestId: "r2" } } };
        if (url.startsWith("/api/blockers")) return { body: { items: [blocker()], nextCursor: null } };
        return undefined;
      },
    });
    renderApp("/queue");
    fireEvent.click(await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" }));
    const banner = (await screen.findByText("Your session ended.")).closest("[role=alert]") as HTMLElement;
    expect(within(banner).getByRole("button", { name: "Reload to sign in" })).toBeTruthy();
  });

  it("explains an Access account with no OnboardFlow access", async () => {
    mockFetch((url) => {
      if (url === "/api/me") return { status: 403, body: { error: { code: "not_provisioned", message: "this email has no OnboardFlow account", requestId: "r3" } } };
      if (url === "/dev/personas") return { status: 404, body: { error: { code: "not_found", message: "not found", requestId: "r4" } } };
      return { body: { ok: true, authMode: "access", version: "1.0.0" } };
    });
    renderApp("/queue");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You are signed in through Cloudflare Access, but this account has no OnboardFlow access. Ask an admin to add you.",
    );
  });
});
