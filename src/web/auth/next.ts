// Where to go after signing in. `next` comes from the URL, so it is untrusted:
// only a same-site path is accepted (one leading slash, no backslash, no
// control characters, not the login page itself), and only one the role can
// open (its navigation, or a case page); anything else goes to the role's home.
import type { MeDto } from "../../shared/api.ts";
import { navFor } from "../components/AppShell.tsx";
import { homeFor } from "./session.tsx";

export function canOpen(me: MeDto, path: string): boolean {
  if (path === "/") return true;
  if (navFor(me).some((n) => n.to === path)) return true;
  const m = /^\/cases\/(E\d{3})$/.exec(path);
  if (m) return me.role !== "employee" || me.employeeId === m[1];
  return false;
}

export function safeNext(raw: string | null | undefined, me: MeDto): string {
  const home = homeFor(me);
  if (!raw) return home;
  // eslint-disable-next-line no-control-regex
  if (!/^\/(?!\/)/.test(raw) || raw.includes("\\") || /[\u0000-\u001f\u007f\s]/.test(raw) || raw.startsWith("/login")) return home;
  const path = raw.split(/[?#]/)[0] ?? "";
  return canOpen(me, path) ? raw : home;
}

/** The login URL that brings the user back to `here` afterwards. */
export function loginUrl(here: string): string {
  return here === "/" || here.startsWith("/login") ? "/login" : `/login?next=${encodeURIComponent(here)}`;
}
