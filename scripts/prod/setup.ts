// Production setup on the Workers Free plan, idempotent: every step looks
// first and changes only what is missing or different, so a second run is a
// no-op apart from the final deploy.
//
//   CF_API_TOKEN=<account API token> npm run prod:setup [-- --dry-run] [--seed-file <sql>] [--rotate-service-token]
//
// wrangler steps use wrangler's own OAuth login (`wrangler login`); the API
// token in CF_API_TOKEN is used only for the Access calls and is never printed
// or passed to wrangler. Steps (README, Production setup):
//   1. preflight     wrangler login and account, API token, Zero Trust team domain, One-time PIN provider
//   2. D1            create onboardflow-prod if missing; write its id into wrangler.jsonc
//   3. migrations    apply pending migrations to the remote database
//   4. seed          load the synthetic seed if the database is empty; upsert the owner and persona logins
//   5. deploy        bootstrap deploy while POLICY_AUD is the placeholder (the Worker fails closed);
//                    the first deploy also uploads a generated SIM_API_KEY
//   6. Access        service token, Allow and Service Auth policies, the self-hosted application; read its AUD
//   7. principal     provision the service token's identity as an admin in D1
//   8. AUD + deploy  write POLICY_AUD into wrangler.jsonc and deploy again
//   9. smoke         unauthenticated requests are stopped by Access; the service token reaches /api/me as admin
//  10. local build   rebuild the dev bundle (the production build replaced dist/)
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccessApp, type AccessPolicy, CloudflareApi, CloudflareApiError, type ServiceToken, accessAppBody, allowPolicyBody, appDrift, policyDrift, servicePolicyBody } from "./cloudflare.ts";
import { REPO, Steps, TOKEN_VARIABLES, lastJson, readServiceToken, run, secretsFile, wrangler, wranglerEnv, wranglerProd, writeServiceToken } from "./exec.ts";
import {
  ACCESS_APP_NAME,
  ACCOUNT_ID,
  ALLOW_POLICY_NAME,
  D1_LOCATION,
  D1_NAME,
  HOSTNAME,
  ORIGIN,
  OTP_IDP_ID,
  PEOPLE,
  SERVICE_POLICY_NAME,
  SERVICE_TOKEN_DURATION,
  SERVICE_TOKEN_NAME,
  TEAM_DOMAIN,
  WORKER_NAME,
  peopleSql,
  serviceIdentitySql,
} from "./settings.ts";
import { productionValues, withDatabaseId, withPolicyAud } from "./wrangler-config.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rotate = args.includes("--rotate-service-token");
const seedFile = args.includes("--seed-file") ? (args[args.indexOf("--seed-file") + 1] ?? "") : "seed/seed.sql";
const CONFIG = join(REPO, "wrangler.jsonc");
const steps = new Steps(dryRun);

function fail(message: string): never {
  console.error(`\nsetup stopped: ${message}`);
  process.exit(1);
}

function check(r: { code: number; stdout: string; stderr: string }, what: string): string {
  if (r.code !== 0) fail(`${what} failed (exit ${r.code}):\n${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r.stdout;
}

/** Runs SQL against the remote database from a temporary file (no secrets in it). */
async function executeSql(sql: string, what: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "onboardflow-sql-"));
  try {
    const file = join(dir, "statements.sql");
    writeFileSync(file, sql);
    check(await wranglerProd(["d1", "execute", D1_NAME, "--remote", "--yes", "--file", file]), what);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function queryOne<T>(sql: string): Promise<T | null> {
  const out = check(await wranglerProd(["d1", "execute", D1_NAME, "--remote", "--json", "--command", sql]), `query ${sql}`);
  const parsed = lastJson<Array<{ results?: T[] }>>(out);
  return parsed[0]?.results?.[0] ?? null;
}

/** Production build (CLOUDFLARE_ENV=production) and wrangler deploy through the Vite plugin's redirected config. */
async function deploy(bootstrap: boolean, simApiKey: string | null): Promise<string> {
  check(await run("node", ["scripts/predeploy-check.ts", "wrangler.jsonc", ...(bootstrap ? ["--bootstrap"] : [])], { echo: true }), "predeploy-check");
  check(await run(join(REPO, "node_modules", ".bin", "vite"), ["build"], { env: { ...wranglerEnv(), CLOUDFLARE_ENV: "production" } }), "production build");
  const dir = simApiKey ? mkdtempSync(join(tmpdir(), "onboardflow-secrets-")) : null;
  try {
    const extra: string[] = [];
    if (dir && simApiKey) {
      const file = join(dir, "secrets.json");
      writeFileSync(file, JSON.stringify({ SIM_API_KEY: simApiKey }), { mode: 0o600 });
      extra.push("--secrets-file", file);
    }
    const out = check(await wrangler(["deploy", "--message", bootstrap ? "onboardflow setup: bootstrap (fails closed until POLICY_AUD)" : "onboardflow setup", ...extra]), "wrangler deploy");
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0];
    if (url && url !== ORIGIN) fail(`the Worker was deployed at ${url}, but the Access application is for ${ORIGIN}; check the workers.dev subdomain`);
    return url ?? ORIGIN;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`OnboardFlow production setup${dryRun ? " (dry run: nothing is created, changed or deployed)" : ""}`);
  console.log(`account ${ACCOUNT_ID}, Worker ${WORKER_NAME} at ${ORIGIN}, Access team ${TEAM_DOMAIN}`);

  // 1 ------------------------------------------------------------------------
  steps.section("Preflight");
  const exported = TOKEN_VARIABLES.filter((k) => k !== "CF_API_TOKEN" && process.env[k]);
  if (exported.length > 0) steps.info(`note: ${exported.join(", ")} is set; it is removed from wrangler's environment so wrangler uses its OAuth login`);
  const who = await steps.read("wrangler whoami --json (OAuth login)", async () => wrangler(["whoami", "--json"]));
  if (who.code !== 0) fail("wrangler is not logged in: run `npx wrangler login` first");
  const whoJson = lastJson<{ accounts?: Array<{ id: string; name: string }>; authType?: string; email?: string }>(who.stdout);
  if (!whoJson.accounts?.some((a) => a.id === ACCOUNT_ID)) fail(`the wrangler login has no access to account ${ACCOUNT_ID}`);
  steps.info(`wrangler: ${whoJson.email ?? "logged in"} (${whoJson.authType ?? "auth type not reported"}), account ${ACCOUNT_ID} present`);
  const token = process.env.CF_API_TOKEN;
  if (!token && !dryRun) fail("CF_API_TOKEN is not set: create an account API token (README, Production setup) and export it for this command only");
  const cf = token ? new CloudflareApi(token, ACCOUNT_ID) : null;
  if (cf) {
    const v = await steps.read("verify CF_API_TOKEN", () => cf.verifyToken());
    if (v.status !== "active") fail(`CF_API_TOKEN is ${v.status}`);
    try {
      const org = await steps.read("Zero Trust organization (team domain)", () => cf.request<{ auth_domain?: string }>("GET", "/access/organizations"));
      if (org.auth_domain && `https://${org.auth_domain}` !== TEAM_DOMAIN) fail(`the Zero Trust team domain is https://${org.auth_domain}, not ${TEAM_DOMAIN}`);
      steps.info(`team domain ${org.auth_domain ?? "(not reported)"}`);
    } catch (err) {
      steps.info(`warning: could not read the Zero Trust organization (${(err as Error).message}); the token needs no permission for it, continuing`);
    }
    try {
      const idp = await steps.read(`identity provider ${OTP_IDP_ID}`, () => cf.request<{ type?: string; name?: string }>("GET", `/access/identity_providers/${OTP_IDP_ID}`));
      if (idp.type && idp.type !== "onetimepin") fail(`identity provider ${OTP_IDP_ID} is ${idp.type}, not the One-time PIN provider`);
      steps.info(`identity provider: ${idp.name ?? OTP_IDP_ID} (${idp.type ?? "type not reported"})`);
    } catch (err) {
      if (err instanceof CloudflareApiError && err.status === 404) fail(`identity provider ${OTP_IDP_ID} does not exist`);
      steps.info(`warning: could not read identity provider ${OTP_IDP_ID} (${(err as Error).message}); it is only referenced, continuing`);
    }
  } else {
    steps.info("CF_API_TOKEN is not set: the dry run plans the Access steps without reading the current Access state");
  }

  // 2 ------------------------------------------------------------------------
  steps.section(`D1 database ${D1_NAME}`);
  const list = lastJson<Array<{ uuid: string; name: string }>>(check(await steps.read("wrangler d1 list --json", () => wrangler(["d1", "list", "--json"])), "wrangler d1 list"));
  let db = list.find((d) => d.name === D1_NAME);
  if (db) {
    steps.info(`exists: ${db.uuid}`);
  } else {
    // Workers Free: 10 databases per account (developers.cloudflare.com/d1/platform/limits)
    if (list.length >= 10) fail(`the account already has ${list.length} D1 databases, the Workers Free limit is 10`);
    steps.info(`not found (${list.length} of 10 databases used on the Free plan)`);
    db = await steps.change(
      `wrangler d1 create ${D1_NAME} --location ${D1_LOCATION}`,
      async () => {
        check(await wrangler(["d1", "create", D1_NAME, "--location", D1_LOCATION]), "wrangler d1 create");
        const again = lastJson<Array<{ uuid: string; name: string }>>(check(await wrangler(["d1", "list", "--json"]), "wrangler d1 list"));
        const created = again.find((d) => d.name === D1_NAME);
        if (!created) fail(`${D1_NAME} was created but is not listed`);
        return created;
      },
      { uuid: "<new database id>", name: D1_NAME },
    );
  }
  const configText = readFileSync(CONFIG, "utf8");
  if (productionValues(configText).databaseId !== db.uuid) {
    await steps.change(`write database_id ${db.uuid} into wrangler.jsonc (env.production.d1_databases[0])`, async () => writeFileSync(CONFIG, withDatabaseId(configText, db.uuid)), undefined);
  } else {
    steps.info("wrangler.jsonc already has this database_id");
  }

  // 3 ------------------------------------------------------------------------
  steps.section("Migrations");
  await steps.change(`wrangler d1 migrations apply ${D1_NAME} --remote --env production (applies only pending ones)`, async () => {
    check(await wranglerProd(["d1", "migrations", "apply", D1_NAME, "--remote"], { echo: true }), "migrations apply");
  }, undefined);

  // 4 ------------------------------------------------------------------------
  steps.section("Seed and logins");
  // under --dry-run the config may still carry the placeholder id, so wrangler could not reach the database yet
  const reachable = productionValues(readFileSync(CONFIG, "utf8")).databaseId === db.uuid;
  const employees = !reachable ? null : await steps.read("SELECT COUNT(*) FROM employees", async () => (await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM employees"))?.n ?? 0);
  if (!reachable) steps.info("whether the database is already seeded is checked once its id is in wrangler.jsonc");
  if (employees === null || employees === 0) {
    await steps.change(`load ${seedFile} (150 synthetic employees, their cases and stages; about 1,700 rows of the 100,000 written per day on Free)`, async () => {
      check(await wranglerProd(["d1", "execute", D1_NAME, "--remote", "--yes", "--file", seedFile], { echo: true }), "seed");
    }, undefined);
  } else {
    steps.info(`already seeded (${employees} employees)`);
  }
  for (const p of PEOPLE) steps.info(`login ${p.email}: ${p.note}`);
  await steps.change(`upsert ${PEOPLE.length} logins (owner admin and personas) into staff and app_users`, () => executeSql(peopleSql(), "logins"), undefined);

  // 5 ------------------------------------------------------------------------
  steps.section("Bootstrap deploy (fails closed until the Access AUD is configured)");
  const secrets = await steps.read(`wrangler secret list (does ${WORKER_NAME} exist, is SIM_API_KEY set)`, () => wranglerProd(["secret", "list", "--format", "json"]));
  const workerExists = secrets.code === 0;
  const hasSimKey = workerExists && /"name":\s*"SIM_API_KEY"/.test(secrets.stdout);
  let audKnown = productionValues(readFileSync(CONFIG, "utf8")).policyAud !== null;
  if (audKnown && workerExists) {
    steps.info("POLICY_AUD is already configured and the Worker exists: no bootstrap deploy needed");
  } else {
    await steps.change(
      `predeploy-check --bootstrap, CLOUDFLARE_ENV=production vite build, wrangler deploy${hasSimKey ? "" : " --secrets-file <generated SIM_API_KEY, temporary 0600 file>"}`,
      async () => deploy(!audKnown, hasSimKey ? null : randomBytes(32).toString("hex")),
      ORIGIN,
    );
  }

  // 6 ------------------------------------------------------------------------
  steps.section("Access (self-hosted application, One-time PIN, Allow and Service Auth policies, service token)");
  let aud = "<AUD of the new application>";
  let clientId = "<client id of the new service token>";
  if (!cf) {
    for (const what of [
      `create service token ${SERVICE_TOKEN_NAME} (duration ${SERVICE_TOKEN_DURATION}); save its client id and secret to ${secretsFile()} (0600, outside the repository)`,
      `create reusable policy ${ALLOW_POLICY_NAME}: allow ${PEOPLE.map((p) => p.email).join(", ")}`,
      `create reusable policy ${SERVICE_POLICY_NAME}: Service Auth for ${SERVICE_TOKEN_NAME}`,
      `create self-hosted application ${ACCESS_APP_NAME} for ${HOSTNAME}: allowed IdP ${OTP_IDP_ID} only, SameSite=Lax, HttpOnly, session 24h, policies 1 ${ALLOW_POLICY_NAME}, 2 ${SERVICE_POLICY_NAME}`,
    ]) await steps.change(what, async () => undefined, undefined);
  } else {
    // service token
    const tokens = await steps.read("service tokens", () => cf.list<ServiceToken>("/access/service_tokens"));
    let st = tokens.find((t) => t.name === SERVICE_TOKEN_NAME);
    const stored = readServiceToken();
    const storedMatches = !!st && !!stored && stored.clientId === st.client_id && stored.accountId === ACCOUNT_ID;
    if (!st) {
      st = await steps.change(`create service token ${SERVICE_TOKEN_NAME} and save it to ${secretsFile()} (0600)`, async () => {
        const created = await cf.request<ServiceToken>("POST", "/access/service_tokens", { name: SERVICE_TOKEN_NAME, duration: SERVICE_TOKEN_DURATION });
        if (!created.client_secret) fail("the service token was created without a client secret in the response");
        writeServiceToken({ accountId: ACCOUNT_ID, tokenId: created.id, name: created.name, clientId: created.client_id, clientSecret: created.client_secret, savedAt: new Date().toISOString(), expiresAt: created.expires_at ?? null });
        return created;
      }, { id: "<new token id>", name: SERVICE_TOKEN_NAME, client_id: clientId });
    } else if (!storedMatches || rotate) {
      // the secret is shown only once; without it locally, rotate (same token id and client id, new secret)
      const why = rotate ? "--rotate-service-token" : `no saved secret for it in ${secretsFile()}`;
      const existing = st;
      await steps.change(`rotate the secret of service token ${SERVICE_TOKEN_NAME} (${why}) and save it (0600)`, async () => {
        const r = await cf.request<{ client_secret: string; client_id?: string }>("POST", `/access/service_tokens/${existing.id}/rotate`, {});
        writeServiceToken({ accountId: ACCOUNT_ID, tokenId: existing.id, name: existing.name, clientId: r.client_id ?? existing.client_id, clientSecret: r.client_secret, savedAt: new Date().toISOString(), expiresAt: existing.expires_at ?? null });
      }, undefined);
    } else {
      steps.info(`service token ${SERVICE_TOKEN_NAME} exists (expires ${st.expires_at ?? "?"}); its secret is saved in ${secretsFile()}`);
    }
    clientId = st.client_id;

    // policies
    const policies = await steps.read("reusable Access policies", () => cf.list<AccessPolicy>("/access/policies"));
    const ensurePolicy = async (name: string, body: Record<string, unknown>): Promise<string> => {
      const have = policies.find((p) => p.name === name);
      if (!have) return steps.change(`create reusable policy ${name}`, async () => (await cf.request<AccessPolicy>("POST", "/access/policies", body)).id, `<${name} id>`);
      const drift = policyDrift(have, body);
      if (drift.length === 0) {
        steps.info(`policy ${name} is up to date`);
        return have.id;
      }
      await steps.change(`update policy ${name} (${drift.join(", ")})`, async () => cf.request("PUT", `/access/policies/${have.id}`, body), undefined);
      return have.id;
    };
    const allowId = await ensurePolicy(ALLOW_POLICY_NAME, allowPolicyBody(PEOPLE.map((p) => p.email)));
    const serviceId = await ensurePolicy(SERVICE_POLICY_NAME, servicePolicyBody(st.id));

    // application
    const apps = await steps.read("Access applications", () => cf.list<AccessApp>("/access/apps"));
    const desired = accessAppBody({ allow: allowId, service: serviceId });
    let app = apps.find((a) => a.name === ACCESS_APP_NAME) ?? apps.find((a) => a.domain === HOSTNAME);
    if (!app) {
      app = await steps.change(`create self-hosted application ${ACCESS_APP_NAME} for ${HOSTNAME} (One-time PIN only, SameSite=Lax, HttpOnly)`, () => cf.request<AccessApp>("POST", "/access/apps", desired), { id: "<app id>", aud, name: ACCESS_APP_NAME });
    } else {
      const drift = appDrift(app, desired);
      const current = app;
      if (drift.length > 0) app = await steps.change(`update application ${ACCESS_APP_NAME} (${drift.join(", ")})`, () => cf.request<AccessApp>("PUT", `/access/apps/${current.id}`, desired), current);
      else steps.info(`application ${ACCESS_APP_NAME} is up to date`);
    }
    aud = app.aud;
    steps.info(`application AUD: ${aud}`);
  }

  // 7 ------------------------------------------------------------------------
  steps.section("Verification principal");
  await steps.change(`provision service-token:${clientId} as an admin (staff V01, app_users)`, () => executeSql(serviceIdentitySql(clientId), "service principal"), undefined);

  // 8 ------------------------------------------------------------------------
  steps.section("Configure the AUD and deploy");
  const text = readFileSync(CONFIG, "utf8");
  audKnown = productionValues(text).policyAud === aud;
  if (!audKnown) await steps.change("write POLICY_AUD into wrangler.jsonc (env.production.vars)", async () => writeFileSync(CONFIG, withPolicyAud(text, aud)), undefined);
  else steps.info("wrangler.jsonc already has this AUD");
  await steps.change("predeploy-check, CLOUDFLARE_ENV=production vite build, wrangler deploy", () => deploy(false, null), ORIGIN);

  // 9 ------------------------------------------------------------------------
  steps.section("Smoke test");
  if (dryRun) {
    steps.info(`would check: GET ${ORIGIN}/api/health without credentials is stopped by Access (302 to ${TEAM_DOMAIN} or 403)`);
    steps.info(`would check: GET ${ORIGIN}/api/me with the service token answers 200 with role admin`);
  } else {
    // Access changes take a few seconds to propagate: retry for up to a minute
    let anon = await fetch(`${ORIGIN}/api/health`, { redirect: "manual" });
    for (let i = 0; i < 12 && anon.status === 200; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      anon = await fetch(`${ORIGIN}/api/health`, { redirect: "manual" });
    }
    if (anon.status === 200) fail(`${ORIGIN}/api/health still answers 200 without credentials after a minute: Access is not in front of the Worker`);
    const loc = anon.headers.get("location") ?? "";
    steps.info(`unauthenticated: HTTP ${anon.status}${loc ? ` -> ${loc.split("/").slice(0, 3).join("/")}` : ""}`);
    const saved = readServiceToken();
    if (!saved) fail(`no service token saved in ${secretsFile()}`);
    let me: Response | null = null;
    for (let i = 0; i < 12; i++) {
      me = await fetch(`${ORIGIN}/api/me`, { redirect: "manual", headers: { "CF-Access-Client-Id": saved.clientId, "CF-Access-Client-Secret": saved.clientSecret } });
      if (me.status === 200) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!me || me.status !== 200) fail(`/api/me with the service token answered HTTP ${me?.status}`);
    const body = (await me.json()) as { role?: string; email?: string };
    if (body.role !== "admin") fail(`/api/me with the service token is ${JSON.stringify(body)}, expected the admin principal`);
    steps.info(`service token: 200 as ${body.email} (${body.role})`);
  }

  // 10 -----------------------------------------------------------------------
  steps.section("Local dev build");
  await steps.change("npm run build (the production build replaced dist/; local dev and evals need the dev build)", async () => {
    check(await run("npm", ["run", "build"]), "npm run build");
  }, undefined);

  console.log(
    dryRun
      ? `\nDry run complete: ${steps.planned.length} changes planned, none made.`
      : `\nDone. ${ORIGIN} is behind Access. Commit wrangler.jsonc (database_id and POLICY_AUD are not secrets), then run \`npm run prod:doctor\` and \`npm run prod:verify\`.`,
  );
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
