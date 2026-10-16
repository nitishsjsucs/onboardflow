// Dev persona picker. In production the app sits behind Cloudflare Access and
// this page only reports who Access signed in. After signing in, the user goes
// back to the page that sent them here (?next=, checked by safeNext).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { actionKeys } from "../api/action-keys.ts";
import { ApiError, apiFetch } from "../api/client.ts";
import { errorText } from "../api/errors.ts";
import { keys } from "../api/queries.ts";
import { safeNext } from "../auth/next.ts";
import { useSession } from "../auth/session.tsx";
import { label } from "../components/StatusBadge.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

type Persona = { email: string; role: string; label: string };

export function LoginPage() {
  useDocumentTitle("Sign in");
  const { me, error: sessionError, expired } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  // Set once /dev/login answered: navigate when the session shows this person (not before, or the
  // protected route would still see the previous session and send the user back here).
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  useEffect(() => {
    if (signedInAs && me?.email.toLowerCase() === signedInAs.toLowerCase() && !expired) navigate(safeNext(next, me), { replace: true });
  }, [signedInAs, me, expired, next, navigate]);
  const personas = useQuery({
    queryKey: ["personas"],
    queryFn: ({ signal }) => apiFetch<Persona[]>("/dev/personas", { signal }),
    retry: false,
  });

  async function login(email: string) {
    setError(null);
    setSigningIn(email);
    try {
      await apiFetch("/dev/login", { method: "POST", body: { email } });
      // A new person: forget the previous persona's answers and action keys.
      actionKeys.clear();
      qc.removeQueries({ predicate: (q) => !(q.queryKey.length === 1 && q.queryKey[0] === keys.me[0]) });
      await qc.invalidateQueries({ queryKey: keys.me, exact: true });
      setSignedInAs(email);
    } catch (e) {
      setError(errorText(e, { action: "sign in" }));
      setSigningIn(null);
    }
  }

  const devUnavailable = personas.error instanceof ApiError && personas.error.status === 404;
  const notProvisioned = sessionError instanceof ApiError && sessionError.code === "not_provisioned";
  const signedIn = me && !expired ? me : null;
  return (
    <main id="main" tabIndex={-1} style={{ maxWidth: 880, margin: "40px auto", padding: "0 16px" }}>
      <h1>OnboardFlow</h1>
      <p className="sub">Employee onboarding across People Operations, IT and Facilities. All people are synthetic; HR, IT and Facilities are simulated systems.</p>
      {expired ? (
        <p className="notice" role="status">
          Your session ended. Sign in again to continue{next ? " where you were" : ""}.
        </p>
      ) : null}
      {signedIn ? (
        <p>
          Signed in as {signedIn.email}. <Link to={safeNext(next, signedIn)}>Continue</Link>
        </p>
      ) : null}
      {notProvisioned ? (
        <div className="card notice error" role="alert">
          You are signed in through Cloudflare Access, but this account has no OnboardFlow access. Ask an admin to add you.
        </div>
      ) : devUnavailable ? (
        <div className="card">
          {signedIn ? (
            `Signed in through Cloudflare Access as ${signedIn.email}.`
          ) : (
            <>
              <p style={{ marginTop: 0 }}>Sign in through Cloudflare Access to continue. Reloading the page takes you to its sign-in.</p>
              <button type="button" className="primary" onClick={() => window.location.reload()}>
                Reload to sign in
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="card">
          <h2>Choose a persona (local development)</h2>
          {personas.isLoading ? (
            <p className="muted" role="status">
              Loading personas...
            </p>
          ) : null}
          {personas.isError && !devUnavailable ? (
            <p className="error" role="alert">
              {errorText(personas.error)}{" "}
              <button type="button" onClick={() => void personas.refetch()}>
                Try again
              </button>
            </p>
          ) : null}
          <div className="personas">
            {(personas.data ?? []).map((p) => (
              <button key={p.email} type="button" onClick={() => void login(p.email)} disabled={signingIn !== null} aria-busy={signingIn === p.email}>
                <strong>{label(p.role)}</strong>
                <br />
                <span className="muted">{p.label}</span>
              </button>
            ))}
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </main>
  );
}
