import { NavLink, Outlet } from "react-router";
import type { MeDto } from "../../shared/api.ts";
import { useSession } from "../auth/session.tsx";
import { label } from "./StatusBadge.tsx";

export type NavItem = { to: string; text: string };

/** Navigation per role (SPEC 17). Department narrows the coordinator menu. */
export function navFor(me: MeDto): NavItem[] {
  switch (me.role) {
    case "employee":
      return [{ to: "/me", text: "My onboarding" }];
    case "manager":
      return [
        { to: "/approvals", text: "Approvals" },
        { to: "/cases", text: "My team" },
      ];
    case "coordinator":
      return [
        { to: "/queue", text: "Queue" },
        { to: "/cases", text: "Cases" },
        { to: "/dashboard", text: "Dashboard" },
        ...(me.department === "people_ops" ? [{ to: "/approvals", text: "Approvals" }] : []),
        { to: "/integrations", text: "Integrations" },
      ];
    case "admin":
      return [
        { to: "/dashboard", text: "Dashboard" },
        { to: "/cases", text: "Cases" },
        { to: "/queue", text: "Queue" },
        { to: "/approvals", text: "Approvals" },
        { to: "/integrations", text: "Integrations" },
        { to: "/audit", text: "Audit" },
      ];
  }
}

export function AppShell() {
  const { me } = useSession();
  if (!me) return <Outlet />;
  return (
    <div className="shell">
      <nav aria-label="main">
        <div className="brand">OnboardFlow</div>
        <div className="who">
          {me.displayName}
          <br />
          {label(me.role)}
          {me.department ? `, ${label(me.department)}` : ""}
        </div>
        {navFor(me).map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
            {n.text}
          </NavLink>
        ))}
        <div className="spacer" />
        <span className="simulated" title="HR, IT and Facilities are simulated systems">Integrations simulated</span>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
