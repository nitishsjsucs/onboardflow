// Parses `env` into AppConfig (SPEC Section 5.2). Invalid configuration fails
// closed: the app answers 500 with a clear code instead of guessing.
import type { JSONWebKeySet, JWK } from "jose";
import { z } from "zod";

export type AuthMode = "access" | "dev";
export type LlmProviderKind = "stub" | "openai" | "workers-ai";

export type AppConfig = {
  authMode: AuthMode;
  access?: { teamDomain: string; audience: string };
  dev?: { issuer: string; audience: string; jwks: JSONWebKeySet; signingJwk?: JWK };
  simClock: boolean;
  evalHooks: boolean;
  idempotencyKeys: boolean;
  retry: { limit: number; baseDelayMs: number };
  poll: { intervalMs: number; max: number };
  integrationTimeoutMs: number;
  gates: {
    waitTimeoutMs: number;
    waitBudget: number;
    maxStageRounds: number;
    maxRecoveryRounds: number;
    maxApprovalRounds: number;
    nudgeAfterS: number;
  };
  blockerScanIntervalS: number;
  hubDebounceS: number;
  approvalSlaHours: number;
  llm: { provider: LlmProviderKind; baseUrl?: string; model: string; apiKey?: string; gatewayId?: string };
  simApiKey: string;
  simBaseUrl: string;
};

export class ConfigError extends Error {
  readonly code: "config_invalid" | "config_placeholder";
  constructor(code: "config_invalid" | "config_placeholder", message: string) {
    super(message);
    this.code = code;
    this.name = "ConfigError";
  }
}

const onOff = z.enum(["on", "off"]).transform((v) => v === "on");
const int = (min = 0) => z.coerce.number().int().min(min);

const RawEnv = z.object({
  AUTH_MODE: z.enum(["access", "dev"]),
  TEAM_DOMAIN: z.string().optional(),
  POLICY_AUD: z.string().optional(),
  DEV_ISSUER: z.string().optional(),
  DEV_AUDIENCE: z.string().optional(),
  DEV_ACCESS_JWKS: z.string().optional(),
  DEV_ACCESS_SIGNING_JWK: z.string().optional(),
  SIM_CLOCK: onOff,
  EVAL_HOOKS: onOff,
  IDEMPOTENCY_KEYS: onOff,
  RETRY_LIMIT: int(),
  RETRY_BASE_DELAY_MS: int(),
  POLL_INTERVAL_MS: int(),
  POLL_MAX: int(1),
  INTEGRATION_TIMEOUT_MS: int(1),
  GATE_WAIT_TIMEOUT_MS: int(1),
  WAIT_BUDGET: int(),
  MAX_STAGE_ROUNDS: int(1),
  MAX_RECOVERY_ROUNDS: int(),
  MAX_APPROVAL_ROUNDS: int(1),
  BLOCKER_SCAN_INTERVAL_S: int(1),
  NUDGE_AFTER_S: int(),
  HUB_DEBOUNCE_S: int(),
  APPROVAL_SLA_HOURS: int(1),
  LLM_PROVIDER: z.enum(["stub", "openai", "workers-ai"]),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().min(1),
  LLM_API_KEY: z.string().optional(),
  AI_GATEWAY_ID: z.string().optional(),
  SIM_API_KEY: z.string().min(1),
  SIM_BASE_URL: z.string().optional(),
});

const JwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) });

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError("config_invalid", `${name} is not valid JSON`);
  }
}

const cache = new WeakMap<object, AppConfig>();

export function parseConfig(env: Env): AppConfig {
  const hit = cache.get(env);
  if (hit) return hit;
  const parsed = RawEnv.safeParse(env as Env & { LLM_API_KEY?: string; SIM_BASE_URL?: string });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError("config_invalid", `invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  let access: AppConfig["access"];
  let dev: AppConfig["dev"];
  if (e.AUTH_MODE === "access") {
    if (!e.TEAM_DOMAIN || !e.POLICY_AUD) {
      throw new ConfigError("config_invalid", "AUTH_MODE=access requires TEAM_DOMAIN and POLICY_AUD");
    }
    if (e.TEAM_DOMAIN.includes("REPLACE") || e.POLICY_AUD.includes("REPLACE")) {
      throw new ConfigError("config_placeholder", "set TEAM_DOMAIN and POLICY_AUD from the Access application");
    }
    access = { teamDomain: e.TEAM_DOMAIN.replace(/\/+$/, ""), audience: e.POLICY_AUD };
  } else {
    if (!e.DEV_ACCESS_JWKS) throw new ConfigError("config_invalid", "AUTH_MODE=dev requires DEV_ACCESS_JWKS");
    const jwks = JwksSchema.safeParse(parseJson("DEV_ACCESS_JWKS", e.DEV_ACCESS_JWKS));
    if (!jwks.success) throw new ConfigError("config_invalid", "DEV_ACCESS_JWKS must be {\"keys\": [...]}");
    dev = {
      issuer: e.DEV_ISSUER ?? "http://localhost/dev-access",
      audience: e.DEV_AUDIENCE ?? "onboardflow-dev",
      jwks: jwks.data as unknown as JSONWebKeySet,
      ...(e.DEV_ACCESS_SIGNING_JWK
        ? { signingJwk: parseJson("DEV_ACCESS_SIGNING_JWK", e.DEV_ACCESS_SIGNING_JWK) as JWK }
        : {}),
    };
  }

  const config: AppConfig = {
    authMode: e.AUTH_MODE,
    ...(access ? { access } : {}),
    ...(dev ? { dev } : {}),
    simClock: e.SIM_CLOCK,
    evalHooks: e.EVAL_HOOKS,
    idempotencyKeys: e.IDEMPOTENCY_KEYS,
    retry: { limit: e.RETRY_LIMIT, baseDelayMs: e.RETRY_BASE_DELAY_MS },
    poll: { intervalMs: e.POLL_INTERVAL_MS, max: e.POLL_MAX },
    integrationTimeoutMs: e.INTEGRATION_TIMEOUT_MS,
    gates: {
      waitTimeoutMs: e.GATE_WAIT_TIMEOUT_MS,
      waitBudget: e.WAIT_BUDGET,
      maxStageRounds: e.MAX_STAGE_ROUNDS,
      maxRecoveryRounds: e.MAX_RECOVERY_ROUNDS,
      maxApprovalRounds: e.MAX_APPROVAL_ROUNDS,
      nudgeAfterS: e.NUDGE_AFTER_S,
    },
    blockerScanIntervalS: e.BLOCKER_SCAN_INTERVAL_S,
    hubDebounceS: e.HUB_DEBOUNCE_S,
    approvalSlaHours: e.APPROVAL_SLA_HOURS,
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      ...(e.LLM_BASE_URL ? { baseUrl: e.LLM_BASE_URL } : {}),
      ...(e.LLM_API_KEY ? { apiKey: e.LLM_API_KEY } : {}),
      ...(e.AI_GATEWAY_ID ? { gatewayId: e.AI_GATEWAY_ID } : {}),
    },
    simApiKey: e.SIM_API_KEY,
    simBaseUrl: e.SIM_BASE_URL ?? "http://localhost",
  };
  cache.set(env, config);
  return config;
}
