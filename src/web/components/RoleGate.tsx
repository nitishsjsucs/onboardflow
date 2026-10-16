import type { ReactNode } from "react";
import type { MeDto } from "../../shared/api.ts";
import type { Role } from "../../shared/roles.ts";
import { hasRole, useSession } from "../auth/session.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

/** The page a role cannot open: its own heading (focused after a navigation) and tab title, and why. */
function Unavailable({ title, message }: { title: string; message: string }) {
  useDocumentTitle(title);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
        </div>
      </div>
      <p className="muted">{message}</p>
    </>
  );
}

/**
 * Renders children only for the given roles (and, with `allow`, only for the principals it accepts,
 * for example People Ops among coordinators). The server enforces the same policy. Anyone else sees
 * `title` as the page heading and `fallback` as the reason.
 */
export function RoleGate({
  roles,
  allow,
  children,
  title = "Not available",
  fallback = "This page is not available for your role.",
}: {
  roles: Role[];
  allow?: (me: MeDto) => boolean;
  children: ReactNode;
  title?: string;
  fallback?: string;
}) {
  const { me } = useSession();
  if (!hasRole(me, ...roles) || (allow && me && !allow(me))) return <Unavailable title={title} message={fallback} />;
  return <>{children}</>;
}
