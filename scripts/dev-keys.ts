// Generates local development secrets: an RS256 key pair for the dev Access
// stand-in (/dev/login signs, the shared verifier checks) and a random
// SIM_API_KEY. `npm run dev:keys` writes them to .dev.vars. The same generator
// is used by vitest.config.ts (fresh keys per test run) and the eval harness
// (fresh keys per eval run).
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair } from "jose";

export const DEV_KID = "dev-1";

export type DevSecrets = {
  /** JSON string {"keys":[publicJwk]} */
  DEV_ACCESS_JWKS: string;
  /** JSON string of the private JWK */
  DEV_ACCESS_SIGNING_JWK: string;
  SIM_API_KEY: string;
};

export async function generateDevSecrets(simApiKey?: string): Promise<DevSecrets> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: DEV_KID, alg: "RS256", use: "sig" };
  const priv = { ...(await exportJWK(privateKey)), kid: DEV_KID, alg: "RS256" };
  return {
    DEV_ACCESS_JWKS: JSON.stringify({ keys: [pub] }),
    DEV_ACCESS_SIGNING_JWK: JSON.stringify(priv),
    SIM_API_KEY: simApiKey ?? randomBytes(24).toString("hex"),
  };
}

export function toDevVars(secrets: DevSecrets): string {
  // Values are single-line JSON; quote them so dotenv parsing keeps them intact.
  return (
    Object.entries(secrets)
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n") + "\n"
  );
}

async function main() {
  const out = process.argv[2] ?? ".dev.vars";
  const secrets = await generateDevSecrets();
  writeFileSync(out, toDevVars(secrets), { mode: 0o600 });
  console.log(`wrote ${out} (DEV_ACCESS_JWKS, DEV_ACCESS_SIGNING_JWK, SIM_API_KEY)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
