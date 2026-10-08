import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  environments: {
    // The worker bundle stays unminified so class names (CaseAgent, OpsHubAgent,
    // OnboardingWorkflow) survive; Agent workflow callbacks route by constructor.name.
    onboardflow: { build: { minify: false } },
  },
});
