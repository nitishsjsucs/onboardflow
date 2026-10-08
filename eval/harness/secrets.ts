// Per-run secrets (SPEC 12.1 step 2): a fresh RS256 key pair and SIM_API_KEY,
// written as a .dev.vars file inside the run's state directory and passed to
// wrangler dev with --env-file (the repository's root .dev.vars is not read).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DevSecrets, generateDevSecrets, toDevVars } from "../../scripts/dev-keys.ts";

export async function writeRunSecrets(stateDir: string): Promise<{ path: string; secrets: DevSecrets }> {
  const secrets = await generateDevSecrets();
  const path = join(stateDir, ".dev.vars");
  writeFileSync(path, toDevVars(secrets), { mode: 0o600 });
  return { path, secrets };
}
