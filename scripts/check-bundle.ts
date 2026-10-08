// Asserts that the Agent and Workflow class names survive bundling. Agent
// workflow callbacks (onWorkflowEvent, onWorkflowComplete, ...) route back to
// the originating Agent by constructor.name, so a minifier that renames
// CaseAgent would silently break every callback.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = ["CaseAgent", "OpsHubAgent", "OnboardingWorkflow"];
const root = "dist/onboardflow";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".js") ? [p] : [];
  });
}

if (!existsSync(root)) {
  console.error(`check-bundle: ${root} not found; run vite build first`);
  process.exit(1);
}
const code = files(root)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
// Either `class CaseAgent ...` or `var CaseAgent = class ...`; in the latter the
// anonymous class takes its .name from the binding (ECMAScript name inference).
const missing = REQUIRED.filter(
  (name) => !new RegExp(`(class ${name}\\b|(var|let|const) ${name} = class\\b)`).test(code),
);
if (missing.length > 0) {
  console.error(`check-bundle: class names missing from worker bundle: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-bundle: ok (${REQUIRED.join(", ")} preserved)`);
