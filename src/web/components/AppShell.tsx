import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import type { MeDto } from "../../shared/api.ts";
import { actionKeys } from "../api/action-keys.ts";
import { apiFetch } from "../api/client.ts";
import { errorText } from "../api/errors.ts";
import { keys } from "../api/queries.ts";
import { loginUrl } from "../auth/next.ts";
import { useAuthMode, useSession } from "../auth/session.tsx";
import { AnnouncerProvider } from "./Announcer.tsx";
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

/** Dev: sign out of the persona and pick another. Clears every cached answer and action key of this persona first. */
function SwitchPersona() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/dev/logout", { method: "POST", body: {} });
    } catch (e) {
      setError(errorText(e, { action: "switch persona" }));
      setBusy(false);
      return;
    }
    actionKeys.clear();
    navigate("/login");
    qc.removeQueries({ predicate: (q) => !(q.queryKey.length === 1 && q.queryKey[0] === keys.me[0]) });
    qc.setQueryData(keys.me, null);
  }
  return (
    <>
      <button type="button" onClick={() => void run()} disabled={busy}>
        {busy ? "Signing out..." : "Switch persona"}
      </button>
      {error ? (
        <div role="alert" className="action-msg error">
          {error}
        </div>
      ) : null}
    </>
  );
}

function SessionEnded({ authMode, here }: { authMode: "access" | "dev" | null; here: string }) {
  return (
    <div className="card notice error" role="alert">
      <strong>Your session ended.</strong>{" "}
      {authMode === "access" ? (
        <>
          Reload the page to sign in through Cloudflare Access again.{" "}
          <button type="button" onClick={() => window.location.reload()}>
            Reload to sign in
          </button>
        </>
      ) : (
        <>
          Sign in again to continue where you were. <Link to={loginUrl(here)}>Sign in again</Link>
        </>
      )}
    </div>
  );
}

export function AppShell() {
  const { me, expired } = useSession();
  const authMode = useAuthMode();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  // After a navigation (not the first render), move focus to the new page's heading, or to main.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(() => {
      const h1 = main.current?.querySelector<HTMLElement>("h1");
      if (h1 && !h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      (h1 ?? main.current)?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [location.pathname]);
  if (!me) return <Outlet />;
  const here = location.pathname + location.search;
  return (
    <AnnouncerProvider>
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
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
          <div className="account">
            <span className="muted" title="Signed in as">
              {me.email}
            </span>
            {authMode === "dev" ? <SwitchPersona /> : null}
            {authMode === "access" ? <a href="/cdn-cgi/access/logout">Sign out</a> : null}
          </div>
          <span className="simulated" title="HR, IT and Facilities are simulated systems">
            Integrations simulated
          </span>
        </nav>
        <main id="main" tabIndex={-1} ref={main}>
          {expired ? <SessionEnded authMode={authMode} here={here} /> : null}
          <Outlet />
        </main>
      </div>
    </AnnouncerProvider>
  );
}
