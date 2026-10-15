// Read-only health check of the production deployment. Changes nothing:
// wrangler reads (whoami, d1 list, migrations list, a COUNT query, secret
// list, deployments list), Access GETs with CF_API_TOKEN when it is set, and
// HTTP GETs against the deployed hostname.
//
//   npm run prod:doctor            (CF_API_TOKEN optional: without it the Access checks are skipped)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkWranglerConfig } from "../predeploy-check.ts";
import { type AccessApp, type AccessPolicy, CloudflareApi, type ServiceToken } from "./cloudflare.ts";
import { REPO, TOKEN_VARIABLES, lastJson, readServiceToken, secretsFile, wrangler, wranglerProd } from "./exec.ts";
import { ACCESS_APP_NAME, ACCOUNT_ID, ALLOW_POLICY_NAME, D1_NAME, HOSTNAME, ORIGIN, OTP_IDP_ID, PEOPLE, SERVICE_POLICY_NAME, SERVICE_TOKEN_NAME, TEAM_DOMAIN, WORKER_NAME } from "./settings.ts";
import { productionValues } from "./wrangler-config.ts";

type Status = "ok" | "warn" | "FAIL" | "skip";
const results: Array<{ status: Status; check: string; detail: string }> = [];

function report(status: Status, check: string, detail = ""): void {
  results.push({ status, check, detail });
  console.log(`${status.padEnd(4)}  ${check}${detail ? `: ${detail}` : ""}`);
}

async function attempt(check: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    report("FAIL", check, err instanceof Error ? err.message.slice(0, 300) : String(err));
  }
}

async function main() {
  console.log(`OnboardFlow production doctor (read-only) for ${ORIGIN}\n`);
  const text = readFileSync(join(REPO, "wrangler.jsonc"), "utf8");
  const cfg = productionValues(text);

  await attempt("wrangler login", async () => {
    const exported = TOKEN_VARIABLES.filter((k) => k !== "CF_API_TOKEN" && process.env[k]);
    if (exported.length) report("warn", "environment", `${exported.join(", ")} is set; the scripts remove it so wrangler uses its OAuth login`);
    const r = await wrangler(["whoami", "--json"]);
    if (r.code !== 0) throw new Error("not logged in (npx wrangler login)");
    const who = lastJson<{ authType?: string; accounts?: Array<{ id: string }> }>(r.stdout);
    if (!who.accounts?.some((a) => a.id === ACCOUNT_ID)) throw new Error(`no access to account ${ACCOUNT_ID}`);
    report("ok", "wrangler login", `${who.authType ?? "?"}, account ${ACCOUNT_ID}`);
  });

  const problems = checkWranglerConfig(text);
  report(problems.length === 0 ? "ok" : "FAIL", "wrangler.jsonc production values", problems.join("; ") || `D1 ${cfg.databaseId}, AUD set, team ${cfg.teamDomain}`);

  await attempt("D1 database", async () => {
    const list = lastJson<Array<{ uuid: string; name: string }>>((await wrangler(["d1", "list", "--json"])).stdout);
    const db = list.find((d) => d.name === D1_NAME);
    if (!db) throw new Error(`${D1_NAME} does not exist`);
    report(db.uuid === cfg.databaseId ? "ok" : "FAIL", "D1 database", `${D1_NAME} ${db.uuid}${db.uuid === cfg.databaseId ? "" : " (wrangler.jsonc has another id)"}; ${list.length} of the Free plan's 10 databases in the account`);
  });

  if (cfg.databaseId) {
    await attempt("D1 migrations", async () => {
      const r = await wranglerProd(["d1", "migrations", "list", D1_NAME, "--remote"]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300));
      const pending = /No migrations to apply/i.test(r.stdout + r.stderr);
      report(pending ? "ok" : "FAIL", "D1 migrations", pending ? "all applied" : "pending migrations: run npm run prod:setup");
    });
    await attempt("D1 seed and logins", async () => {
      const emails = PEOPLE.map((p) => `'${p.email}'`).join(",");
      const r = await wranglerProd([
        "d1",
        "execute",
        D1_NAME,
        "--remote",
        "--json",
        "--command",
        `SELECT (SELECT COUNT(*) FROM employees) AS employees, (SELECT COUNT(*) FROM app_users WHERE active = 1 AND email IN (${emails})) AS logins, (SELECT COUNT(*) FROM app_users WHERE active = 1 AND email LIKE 'service-token:%') AS service, (SELECT COUNT(*) FROM cases WHERE status <> 'not_started') AS started, (SELECT COALESCE(SUM(drafts), 0) FROM llm_daily_usage WHERE day = date('now')) AS drafts_today`,
      ]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300));
      const row = lastJson<Array<{ results: Array<Record<string, number>> }>>(r.stdout)[0]?.results[0] ?? {};
      const ok = row.employees === 150 && row.logins === PEOPLE.length && row.service === 1;
      report(ok ? "ok" : "FAIL", "D1 seed and logins", `${row.employees} employees, ${row.logins}/${PEOPLE.length} logins, ${row.service} service principal, ${row.started} cases started, ${row.drafts_today}/${cfg.llmDailyDraftLimit ?? "?"} LLM drafts today (UTC)`);
    });
  } else {
    report("skip", "D1 migrations and seed", "no database_id in wrangler.jsonc yet");
  }

  await attempt("Worker and secrets", async () => {
    const s = await wranglerProd(["secret", "list", "--format", "json"]);
    if (s.code !== 0) throw new Error(`${WORKER_NAME} is not deployed`);
    const hasKey = /"name":\s*"SIM_API_KEY"/.test(s.stdout);
    report(hasKey ? "ok" : "FAIL", "Worker and secrets", `${WORKER_NAME} exists; SIM_API_KEY ${hasKey ? "set" : "missing"}`);
    const d = await wranglerProd(["deployments", "list", "--json"]);
    if (d.code === 0) {
      const list = lastJson<Array<{ created_on?: string; annotations?: Record<string, string> }>>(d.stdout);
      const latest = list[list.length - 1] ?? list[0];
      report("ok", "latest deployment", `${latest?.created_on ?? "?"} ${latest?.annotations?.["workers/message"] ?? ""}`.trim());
    }
  });

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    report("skip", "Access", "CF_API_TOKEN not set");
  } else {
    const cf = new CloudflareApi(token, ACCOUNT_ID);
    await attempt("Access application", async () => {
      const apps = await cf.list<AccessApp>("/access/apps");
      const app = apps.find((a) => a.name === ACCESS_APP_NAME);
      if (!app) throw new Error(`no application named ${ACCESS_APP_NAME}`);
      const issues: string[] = [];
      if (app.domain !== HOSTNAME) issues.push(`domain ${app.domain}`);
      if (JSON.stringify(app.allowed_idps) !== JSON.stringify([OTP_IDP_ID])) issues.push(`allowed_idps ${JSON.stringify(app.allowed_idps)}`);
      if (app.same_site_cookie_attribute !== "lax") issues.push(`SameSite ${app.same_site_cookie_attribute}`);
      if (app.http_only_cookie_attribute !== true) issues.push("HttpOnly off");
      if (app.aud !== cfg.policyAud) issues.push("AUD differs from wrangler.jsonc POLICY_AUD");
      const policies = await cf.list<AccessPolicy>("/access/policies");
      const names = (app.policies ?? []).map((p) => p.name ?? policies.find((x) => x.id === p.id)?.name);
      if (!names.includes(ALLOW_POLICY_NAME) || !names.includes(SERVICE_POLICY_NAME)) issues.push(`policies ${JSON.stringify(names)}`);
      report(issues.length ? "FAIL" : "ok", "Access application", issues.join("; ") || `${HOSTNAME}, One-time PIN only, SameSite=Lax, HttpOnly, policies ${names.join(", ")}, AUD matches`);
    });
    await attempt("Access service token", async () => {
      const t = (await cf.list<ServiceToken>("/access/service_tokens")).find((x) => x.name === SERVICE_TOKEN_NAME);
      if (!t) throw new Error(`no service token named ${SERVICE_TOKEN_NAME}`);
      const days = t.expires_at ? Math.floor((Date.parse(t.expires_at) - Date.now()) / 86_400_000) : null;
      report(days !== null && days < 30 ? "warn" : "ok", "Access service token", `expires ${t.expires_at ?? "?"}${days !== null ? ` (${days} days)` : ""}`);
    });
  }

  await attempt("saved service token", async () => {
    const t = readServiceToken();
    report(t ? "ok" : "FAIL", "saved service token", t ? `client id ${t.clientId} in ${secretsFile()} (0600)` : `missing: ${secretsFile()}`);
  });

  await attempt("HTTP", async () => {
    const anon = await fetch(`${ORIGIN}/api/health`, { redirect: "manual" });
    const loc = anon.headers.get("location") ?? "";
    const guarded = anon.status !== 200 && (anon.status === 401 || anon.status === 403 || loc.startsWith(TEAM_DOMAIN));
    report(guarded ? "ok" : "FAIL", "unauthenticated request", `HTTP ${anon.status}${loc ? ` -> ${loc.split("/").slice(0, 3).join("/")}` : ""}${guarded ? " (Access)" : " (not stopped by Access)"}`);
    const t = readServiceToken();
    if (!t) return;
    const h = { "CF-Access-Client-Id": t.clientId, "CF-Access-Client-Secret": t.clientSecret };
    const health = await fetch(`${ORIGIN}/api/health`, { redirect: "manual", headers: h });
    const body = health.status === 200 ? ((await health.json()) as { authMode?: string; version?: string }) : null;
    report(body?.authMode === "access" ? "ok" : "FAIL", "service token /api/health", `HTTP ${health.status}${body ? ` authMode ${body.authMode}, version ${body.version}` : ""}`);
    const me = await fetch(`${ORIGIN}/api/me`, { redirect: "manual", headers: h });
    const p = me.status === 200 ? ((await me.json()) as { role?: string; email?: string }) : null;
    report(p?.role === "admin" ? "ok" : "FAIL", "service token /api/me", `HTTP ${me.status}${p ? ` ${p.email} (${p.role})` : ""}`);
  });

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${failed === 0 ? "healthy" : `${failed} check(s) failed`} (${results.filter((r) => r.status === "warn").length} warnings, ${results.filter((r) => r.status === "skip").length} skipped)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`doctor stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
