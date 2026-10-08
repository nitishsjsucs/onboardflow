// Dev persona picker. In production the app sits behind Cloudflare Access and
// this page only reports who Access signed in.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../api/client.ts";
import { keys } from "../api/queries.ts";
import { useSession } from "../auth/session.tsx";
import { label } from "../components/StatusBadge.tsx";

type Persona = { email: string; role: string; label: string };

export function LoginPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const personas = useQuery({
    queryKey: ["personas"],
    queryFn: () => apiFetch<Persona[]>("/dev/personas"),
    retry: false,
  });

  async function login(email: string) {
    setError(null);
    try {
      await apiFetch("/dev/login", { method: "POST", body: { email } });
      await qc.invalidateQueries({ queryKey: keys.me });
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const devUnavailable = personas.error instanceof ApiError && personas.error.status === 404;
  return (
    <main style={{ maxWidth: 880, margin: "40px auto", padding: "0 16px" }}>
      <h1>OnboardFlow</h1>
      <p className="sub">Employee onboarding across People Operations, IT and Facilities. All people are synthetic; HR, IT and Facilities are simulated systems.</p>
      {me ? <p>Signed in as {me.email}.</p> : null}
      {devUnavailable ? (
        <div className="card">{me ? `Signed in through Cloudflare Access as ${me.email}.` : "Sign in through Cloudflare Access to continue."}</div>
      ) : (
        <div className="card">
          <h2>Choose a persona (local development)</h2>
          {personas.isLoading ? <p className="muted">Loading personas...</p> : null}
          <div className="personas">
            {(personas.data ?? []).map((p) => (
              <button key={p.email} type="button" onClick={() => void login(p.email)}>
                <strong>{label(p.role)}</strong>
                <br />
                <span className="muted">{p.label}</span>
              </button>
            ))}
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>
      )}
    </main>
  );
}
