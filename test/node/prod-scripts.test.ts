// The pure parts of the production scripts (scripts/prod): the SQL the setup runs (executed here against the
// real migrations and seed in SQLite), the wrangler.jsonc edits, the Access payloads and drift checks, the tail
// stream parser and CPU summary, the verification plan and the neuron estimate, and the environment wrangler
// runs with. The case driver itself is tested against the real Worker in test/worker/prod-verify-driver.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { accessAppBody, allowPolicyBody, appDrift, policyDrift, servicePolicyBody } from "../../scripts/prod/cloudflare.ts";
import { lastJson, redact, wranglerEnv } from "../../scripts/prod/exec.ts";
import { ACCOUNT_ID, HOSTNAME, OTP_IDP_ID, PEOPLE, peopleSql, serviceIdentity, serviceIdentitySql, VERIFY_RESERVE } from "../../scripts/prod/settings.ts";
import { classify, JsonObjectStream, summarize, type TailEvent } from "../../scripts/prod/tail.ts";
import { neurons, planCases } from "../../scripts/prod/verify.ts";
import { PLACEHOLDER_AUD, PLACEHOLDER_DB_ID, productionValues, withDatabaseId, withPolicyAud } from "../../scripts/prod/wrangler-config.ts";
import { committedConfig, preSetupConfig } from "./pre-setup-config.ts";

function seededDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  db.exec(readFileSync("seed/seed.sql", "utf8"));
  return db;
}

describe("setup SQL (against the migrations and the committed seed)", () => {
  it("maps the owner and personas onto logins, idempotently, and every login loads as a consistent principal", () => {
    const db = seededDb();
    db.exec(peopleSql());
    db.exec(peopleSql());
    const rows = db
      .prepare(
        `SELECT u.email, u.role, u.employee_id, u.staff_id, s.kind, s.department FROM app_users u LEFT JOIN staff s ON s.id = u.staff_id
          WHERE u.email LIKE 'nitishsancs%' AND u.active = 1 ORDER BY u.email`,
      )
      .all() as Array<{ email: string; role: string; employee_id: string | null; staff_id: string | null; kind: string | null; department: string | null }>;
    expect(rows).toHaveLength(PEOPLE.length);
    for (const r of rows) {
      // the consistency loadPrincipal enforces (src/worker/auth/middleware.ts)
      if (r.role === "employee") expect(r.employee_id).not.toBeNull();
      else expect(r.kind).toBe(r.role);
      if (r.role === "coordinator") expect(r.department).not.toBeNull();
    }
    expect(rows.find((r) => r.email === "nitishsancs@gmail.com")).toMatchObject({ role: "admin", staff_id: "P01" });
    expect(rows.find((r) => r.email === "nitishsancs+hr@gmail.com")).toMatchObject({ role: "coordinator", department: "people_ops" });
    expect(rows.find((r) => r.email === "nitishsancs+it@gmail.com")).toMatchObject({ role: "coordinator", department: "it" });
    expect(rows.find((r) => r.email === "nitishsancs+facilities@gmail.com")).toMatchObject({ role: "coordinator", department: "facilities" });
    // the manager persona manages the employee persona, so it can approve that case
    const managerOfPersona = db.prepare("SELECT manager_id FROM employees WHERE id = 'E014'").get() as { manager_id: string };
    expect(rows.find((r) => r.email === "nitishsancs+manager@gmail.com")?.staff_id).toBe(managerOfPersona.manager_id);
    // the reserve the verification script consumes is distinct from the persona's employee
    expect(VERIFY_RESERVE).not.toContain("E014");
  });

  it("provisions exactly one active service principal and retires an earlier token's identity", () => {
    const db = seededDb();
    db.exec(serviceIdentitySql("aaaa1111.access"));
    db.exec(serviceIdentitySql("aaaa1111.access"));
    db.exec(serviceIdentitySql("BBBB2222.access"));
    const active = db.prepare("SELECT email, role, staff_id FROM app_users WHERE email LIKE 'service-token:%' AND active = 1").all();
    expect(active).toEqual([{ email: "service-token:bbbb2222.access", role: "admin", staff_id: "V01" }]);
    expect(db.prepare("SELECT kind, email FROM staff WHERE id = 'V01'").get()).toEqual({ kind: "admin", email: "service-token:bbbb2222.access" });
    expect(() => serviceIdentity("bad id'); DROP TABLE x;--")).toThrow(/format/);
  });
});

describe("wrangler.jsonc edits", () => {
  // the config as it is before a setup run: the committed file with both placeholders back
  const text = preSetupConfig;

  it("reproduces the committed config byte for byte from the pre-setup one and the values the setup wrote", () => {
    const { databaseId, policyAud } = productionValues(committedConfig);
    expect(databaseId).not.toBeNull();
    expect(policyAud).not.toBeNull();
    expect(withPolicyAud(withDatabaseId(text, databaseId ?? ""), policyAud ?? "")).toBe(committedConfig);
  });

  it("writes the database id and the AUD in place and keeps every comment", () => {
    expect(productionValues(text)).toMatchObject({ databaseId: null, policyAud: null, teamDomain: "https://old-truth-a7dc.cloudflareaccess.com", llmDailyDraftLimit: 20 });
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    const aud = "a".repeat(64);
    const edited = withPolicyAud(withDatabaseId(text, id), aud);
    expect(productionValues(edited)).toMatchObject({ databaseId: id, policyAud: aud });
    expect(edited.match(/\/\/.*$/gm)).toEqual(text.match(/\/\/.*$/gm));
    expect(edited).not.toContain(PLACEHOLDER_DB_ID);
    expect(edited).not.toContain(PLACEHOLDER_AUD);
    // only those two values changed
    const a = parse(text) as { env: { production: Record<string, unknown> } };
    const b = parse(edited) as { env: { production: Record<string, unknown> } };
    expect({ ...b.env.production, vars: { ...(b.env.production.vars as object), POLICY_AUD: "x" }, d1_databases: null }).toEqual({ ...a.env.production, vars: { ...(a.env.production.vars as object), POLICY_AUD: "x" }, d1_databases: null });
    expect(() => withDatabaseId(text, "nope")).toThrow();
    expect(() => withPolicyAud(text, "not-hex")).toThrow();
  });
});

describe("Access payloads", () => {
  it("builds a hostname application on the workers.dev host with only the One-time PIN provider and Lax, HttpOnly cookies", () => {
    const body = accessAppBody({ allow: "p1", service: "p2" });
    expect(body).toMatchObject({
      type: "self_hosted",
      domain: HOSTNAME,
      allowed_idps: [OTP_IDP_ID],
      auto_redirect_to_identity: true,
      same_site_cookie_attribute: "lax",
      http_only_cookie_attribute: true,
      policies: [
        { id: "p1", precedence: 1 },
        { id: "p2", precedence: 2 },
      ],
    });
    expect(HOSTNAME).toBe("onboardflow-production.nitish-ratakonda.workers.dev");
    expect(String(body.name).startsWith("onboardflow")).toBe(true);
  });

  it("allows exactly the configured emails, and Service Auth for exactly one token", () => {
    expect(allowPolicyBody(PEOPLE.map((p) => p.email))).toMatchObject({ decision: "allow", include: PEOPLE.map((p) => ({ email: { email: p.email } })) });
    expect(servicePolicyBody("tok-1")).toMatchObject({ decision: "non_identity", include: [{ service_token: { token_id: "tok-1" } }] });
  });

  it("reports drift only for fields that differ", () => {
    const desired = accessAppBody({ allow: "p1", service: "p2" });
    const current = { ...desired, id: "app", aud: "x", policies: [{ id: "p1", precedence: 1, name: "a" }, { id: "p2", precedence: 2, name: "b" }] } as never;
    expect(appDrift(current, desired)).toEqual([]);
    expect(appDrift({ ...(current as object), same_site_cookie_attribute: "none", allowed_idps: ["other"] } as never, desired)).toEqual(["allowed_idps", "same_site_cookie_attribute"]);
    expect(appDrift({ ...(current as object), policies: [{ id: "p2" }, { id: "p1" }] } as never, desired)).toEqual(["policies"]);
    const policy = { id: "x", name: "n", ...allowPolicyBody(["b@x.test", "a@x.test"]) } as never;
    expect(policyDrift(policy, allowPolicyBody(["a@x.test", "b@x.test"]))).toEqual([]);
    expect(policyDrift(policy, allowPolicyBody(["a@x.test"]))).toEqual(["include"]);
  });
});

describe("wrangler tail measurements", () => {
  it("splits concatenated pretty-printed JSON objects across chunk boundaries, including braces inside strings", () => {
    const s = new JsonObjectStream();
    const a = JSON.stringify({ outcome: "ok", logs: [{ message: ["brace } in { a string"] }] }, null, 2);
    const b = JSON.stringify({ outcome: "exceededCpu", cpuTime: 12 });
    const all = `Connected {not json}\n${a}\n${b}\n`;
    const out: unknown[] = [];
    for (let i = 0; i < all.length; i += 7) out.push(...s.push(all.slice(i, i + 7)));
    expect(out).toEqual([JSON.parse(a), JSON.parse(b)]);
  });

  it("holds each invocation to its plan limit and summarizes CPU per kind", () => {
    const ev = (o: Partial<TailEvent>): TailEvent => ({ outcome: "ok", exceptions: [], logs: [], ...o });
    const events = [
      ev({ cpuTime: 2, wallTime: 30, executionModel: "stateless", event: { request: { url: "https://h/api/cases/E141" } } }),
      ev({ cpuTime: 4, wallTime: 40, executionModel: "stateless", event: { request: { url: "https://h/api/me" } } }),
      ev({ cpuTime: 11, wallTime: 50, executionModel: "stateless", event: { request: { url: "https://h/sim/it/v1/accounts" } }, outcome: "exceededCpu" }),
      ev({ cpuTime: 7, entrypoint: "OnboardingWorkflow", event: {} }),
      ev({ cpuTime: 40, executionModel: "durableObject", entrypoint: "CaseAgent", event: { rpcMethod: "scanBlockers" } }),
      ev({ executionModel: "durableObject", entrypoint: "OpsHubAgent", event: { scheduledTime: 1 }, exceptions: [{ name: "Error", message: "Too many subrequests." }], outcome: "exception" }),
    ];
    expect(classify(events[2]!)).toMatchObject({ limitMs: 10 });
    expect(classify(events[3]!)).toMatchObject({ kind: "workflow (OnboardingWorkflow)", limitMs: 10 });
    expect(classify(events[4]!)).toMatchObject({ kind: "durable object CaseAgent (rpc)", limitMs: 30_000 });
    const s = summarize(events);
    expect(s).toMatchObject({ events: 6, eventsWithCpuTime: 5, overLimit: 1, notOk: { exceededCpu: 1, exception: 1 }, subrequestLimitErrors: 1 });
    const api = s.groups.find((g) => g.kind === "worker fetch /api/*");
    expect(api).toMatchObject({ invocations: 2, cpuMs: { p50: 2, max: 4 }, overLimit: 0 });
    expect(s.groups.find((g) => g.kind.startsWith("durable object CaseAgent"))?.overLimit).toBe(0);
  });
});

describe("verification plan and cost", () => {
  it("drives at most 5 cases, at most 3 of them on the LLM path, from reserved employees only", () => {
    expect(planCases([...VERIFY_RESERVE], 3, 1)).toEqual([
      { employeeId: "E141", path: "data_issue" },
      { employeeId: "E142", path: "happy" },
      { employeeId: "E143", path: "happy" },
    ]);
    expect(() => planCases([...VERIFY_RESERVE], 6, 1)).toThrow(/--count/);
    expect(() => planCases([...VERIFY_RESERVE], 5, 4)).toThrow(/--llm-cases/);
    expect(() => planCases(["E150"], 2, 0)).toThrow(/still not started/);
  });

  it("prices drafts in neurons from the published per-model rates", () => {
    // a 500 token prompt and the 300 token output cap with qwen3-30b-a3b-fp8: about 11.5 neurons
    expect(neurons("@cf/qwen/qwen3-30b-a3b-fp8", 500, 300)).toBeCloseTo(11.455, 3);
    expect(neurons("@cf/unknown/model", 1, 1)).toBeNull();
  });
});

describe("process plumbing", () => {
  it("never hands wrangler an API token, pins the account and turns metrics off", () => {
    const env = wranglerEnv({ PATH: "/bin", CLOUDFLARE_API_TOKEN: "t1", CF_API_TOKEN: "t2", CLOUDFLARE_API_KEY: "k", CLOUDFLARE_EMAIL: "e" });
    expect(env).toEqual({ PATH: "/bin", CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" });
  });

  it("reads the JSON after wrangler's banner, and redacts secrets from text", () => {
    expect(lastJson('⛅️ wrangler 4\n[{"results":[{"n":150}],"success":true}]')).toEqual([{ results: [{ n: 150 }], success: true }]);
    expect(lastJson('banner {x}\n{"a":{"b":[1,2]}}')).toEqual({ a: { b: [1, 2] } });
    expect(redact("secret=abcdef123456 and abcdef123456", ["abcdef123456", "short"])).toBe("secret=[redacted] and [redacted]");
  });
});
