// The production verification driver (scripts/prod/drive.ts) against the real Worker in workerd: the same
// code verify.ts runs through Access with a service token, here with an admin's dev token as transport.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { driveCase, rejectedBundleFor, type Transport } from "../../scripts/prod/drive.ts";
import { tokenFor } from "../helpers/api.ts";
import { fastWorkflows } from "../helpers/workflow.ts";

async function adminTransport(): Promise<Transport> {
  const token = await tokenFor("A01");
  return (path, init) =>
    exports.default.fetch(new Request(`http://localhost${path}`, { method: init.method, headers: { ...init.headers, "Cf-Access-Jwt-Assertion": token }, ...(init.body !== undefined ? { body: init.body } : {}) }));
}

const opts = async () => ({ transport: await adminTransport(), origin: "http://localhost", pollMs: 100, caseTimeoutMs: 60_000, followUpWaitMs: 10_000 });

describe("production verification driver", () => {
  it("drives a case from not_started to complete as one admin (happy path)", async () => {
    const intro = await fastWorkflows();
    try {
      const out = await driveCase("E141", "happy", await opts());
      expect(out).toMatchObject({ employeeId: "E141", path: "happy", status: "complete", error: null, unexpectedBlocks: [], followUps: [] });
      expect(out.instanceId).toBe("onb-E141-1");
      const whats = out.actions.map((a) => a.what);
      expect(whats[0]).toBe("POST /api/cases/E141/start");
      expect(whats.filter((w) => w.endsWith("/decision"))).toHaveLength(2);
      expect(whats.filter((w) => w.includes("/api/tasks/")).length).toBeGreaterThan(0);
      expect(out.actions.every((a) => a.status < 300)).toBe(true);
    } finally {
      await intro.dispose();
    }
  });

  it("drives the data issue path: IT refuses the bundle, the agent opens a blocker with a follow-up, the driver corrects and retries", async () => {
    const intro = await fastWorkflows();
    try {
      const out = await driveCase("E142", "data_issue", await opts());
      expect(out).toMatchObject({ status: "complete", error: null, unexpectedBlocks: [] });
      expect(out.blockers).toEqual([expect.objectContaining({ kind: "data_issue", ownerDepartment: "it", subject: "it.assign-licenses" })]);
      // the stub drafts in tests; in production this records the Workers AI provider and its token usage
      expect(out.followUps).toEqual([expect.objectContaining({ blockerKind: "data_issue", draftedBy: "stub", provider: "stub", error: null })]);
      const whats = out.actions.map((a) => a.what);
      expect(whats.filter((w) => w === "PATCH /api/employees/E142")).toHaveLength(2);
      expect(whats).toContain("POST /api/cases/E142/stages/it_provisioning/retry");
      // the correction came after the follow-up existed, and was not refused by the bundle lock
      expect(out.actions.filter((a) => a.what === "PATCH /api/employees/E142").map((a) => a.status)).toEqual([200, 200]);
    } finally {
      await intro.dispose();
    }
  });

  it("starts only not_started cases and reports, rather than throws, what went wrong", async () => {
    const out = await driveCase("E141", "happy", await opts());
    expect(out).toMatchObject({ status: "error", error: expect.stringMatching(/E141 is complete; the driver starts only not_started cases/) });
    expect(rejectedBundleFor("full_time")).toBe("contractor-basic");
    expect(rejectedBundleFor("contractor")).toBe("intern-basic");
    expect(rejectedBundleFor("intern")).toBe("contractor-basic");
  });
});
