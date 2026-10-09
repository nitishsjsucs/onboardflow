import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Stamps dist/build-info.json with the commit and tree state the build came from. The eval harness
 * refuses a build whose commit differs from HEAD or that came from a dirty tree, and records the
 * stamp and a hash of dist/ in every run (eval/harness/server.ts readBuild).
 */
function buildInfo(): Plugin {
  return {
    name: "onboardflow-build-info",
    apply: "build",
    closeBundle: {
      sequential: true,
      handler() {
        mkdirSync("dist", { recursive: true });
        const info = { commit: git(["rev-parse", "HEAD"]), dirtyTree: git(["status", "--porcelain"]) !== "", builtAt: new Date().toISOString(), cloudflareEnv: process.env.CLOUDFLARE_ENV ?? null };
        writeFileSync("dist/build-info.json", `${JSON.stringify(info, null, 2)}\n`);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), cloudflare(), buildInfo()],
  environments: {
    // The worker bundle stays unminified so class names (CaseAgent, OpsHubAgent,
    // OnboardingWorkflow) survive; Agent workflow callbacks route by constructor.name.
    onboardflow: { build: { minify: false } },
  },
});
