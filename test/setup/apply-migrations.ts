// Runs once per worker test file (storage is isolated per file): apply the D1
// migrations, then the committed seed, both handed over as Miniflare bindings
// by vitest.config.ts. Test-only bindings are read through a local cast so
// Cloudflare.Env is never augmented (that would break Agent<Env> assignability).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_SEED: string[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

const seeded = await testEnv.DB.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'employees'",
).first();
if (seeded && testEnv.TEST_SEED.length > 0) {
  const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM employees").first<{ n: number }>();
  if ((count?.n ?? 0) === 0) {
    await testEnv.DB.batch(testEnv.TEST_SEED.map((s) => testEnv.DB.prepare(s)));
  }
}

// Pin the simulated clock (SIM_CLOCK=on in tests) to the seed's reference date,
// as the eval harness does, so date-dependent rules (overdue tasks and
// approvals) do not drift with the calendar.
export const TEST_SIMULATED_NOW = "2026-10-08T12:00:00.000Z";
const pinned = await testEnv.DB.prepare("SELECT offset_ms FROM sim_clock WHERE id = 1").first<{ offset_ms: number }>();
if (pinned && pinned.offset_ms === 0) {
  await testEnv.DB.prepare("UPDATE sim_clock SET offset_ms = ? WHERE id = 1").bind(Date.parse(TEST_SIMULATED_NOW) - Date.now()).run();
}
