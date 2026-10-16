// Route table (SPEC 17). Exported as data so tests can mount it in a memory router.
import { Navigate, Outlet, type RouteObject, createBrowserRouter, useLocation } from "react-router";
import { loginUrl } from "./auth/next.ts";
import { homeFor, isSignedOut, useSession } from "./auth/session.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { QueryError } from "./components/QueryState.tsx";
import { useDocumentTitle } from "./hooks/useDocumentTitle.ts";
import { RoleGate } from "./components/RoleGate.tsx";
import { ApprovalsPage } from "./pages/ApprovalsPage.tsx";
import { CaseDetailPage } from "./pages/CaseDetailPage.tsx";
import { CasesPage } from "./pages/CasesPage.tsx";
import { AuditPage } from "./pages/AuditPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { IntegrationsPage } from "./pages/IntegrationsPage.tsx";
import { EmployeePortalPage } from "./pages/EmployeePortalPage.tsx";
import { QueuePage } from "./pages/QueuePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";

/**
 * Signed out: go to the login page and come back here afterwards (/login?next=..., checked by safeNext).
 * If /api/me failed for another reason (a 5xx, the network), the session is unknown: say so and offer
 * Try again on this URL, instead of sending a signed-in user to the login page.
 */
function RequireSession() {
  const { me, loading, error } = useSession();
  const location = useLocation();
  if (loading)
    return (
      <p className="muted" role="status" style={{ padding: 24 }}>
        Loading...
      </p>
    );
  if (!me && error && !isSignedOut(error)) return <SessionUnknown />;
  if (!me) return <Navigate to={loginUrl(location.pathname + location.search)} replace />;
  return <Outlet />;
}

function SessionUnknown() {
  const { error, refetch, fetching } = useSession();
  useDocumentTitle("Could not load");
  return (
    <main id="main" tabIndex={-1} style={{ maxWidth: 880, margin: "40px auto", padding: "0 16px" }}>
      <h1>OnboardFlow</h1>
      <QueryError error={error} what="who is signed in" onRetry={refetch} busy={fetching} />
    </main>
  );
}

function Home() {
  const { me } = useSession();
  return me ? <Navigate to={homeFor(me)} replace /> : <Navigate to="/login" replace />;
}

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <Home /> },
          {
            path: "/me",
            element: (
              <RoleGate roles={["employee"]}>
                <EmployeePortalPage />
              </RoleGate>
            ),
          },
          {
            path: "/approvals",
            element: (
              // the same rule and wording as GET /api/approvals: IT and Facilities coordinators get a 403 there
              <RoleGate roles={["manager", "coordinator", "admin"]} allow={(me) => me.role !== "coordinator" || me.department === "people_ops"} title="Approvals" fallback="Approvals are handled by managers and People Ops.">
                <ApprovalsPage />
              </RoleGate>
            ),
          },
          {
            path: "/queue",
            element: (
              <RoleGate roles={["coordinator", "admin"]}>
                <QueuePage />
              </RoleGate>
            ),
          },
          {
            path: "/cases",
            element: (
              <RoleGate roles={["manager", "coordinator", "admin"]}>
                <CasesPage />
              </RoleGate>
            ),
          },
          { path: "/cases/:id", element: <CaseDetailPage /> },
          {
            path: "/dashboard",
            element: (
              <RoleGate roles={["coordinator", "admin"]}>
                <DashboardPage />
              </RoleGate>
            ),
          },
          {
            path: "/integrations",
            element: (
              <RoleGate roles={["coordinator", "admin"]}>
                <IntegrationsPage />
              </RoleGate>
            ),
          },
          {
            path: "/audit",
            element: (
              <RoleGate roles={["admin"]}>
                <AuditPage />
              </RoleGate>
            ),
          },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
