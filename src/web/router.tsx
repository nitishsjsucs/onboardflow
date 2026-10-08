// Route table (SPEC 17). Exported as data so tests can mount it in a memory router.
import { Navigate, Outlet, type RouteObject, createBrowserRouter } from "react-router";
import { homeFor, useSession } from "./auth/session.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { RoleGate } from "./components/RoleGate.tsx";
import { EmployeePortalPage } from "./pages/EmployeePortalPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";

function RequireSession() {
  const { me, loading } = useSession();
  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading...</p>;
  if (!me) return <Navigate to="/login" replace />;
  return <Outlet />;
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
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
