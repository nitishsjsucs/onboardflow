import { describe, expect, it } from "vitest";
import { ledger, sim, simJson, workerAndAccount, workerBody } from "../helpers/sims.ts";

describe("simulated systems: auth", () => {
  it("rejects a missing or wrong X-Sim-Api-Key with 401", async () => {
    expect((await sim("/hr/v1/workers", { body: workerBody("S001"), key: "k1", apiKey: null })).status).toBe(401);
    expect((await sim("/hr/v1/workers", { body: workerBody("S001"), key: "k1", apiKey: "wrong" })).status).toBe(401);
    expect((await ledger({ employeeRef: "S001" })).length).toBe(0);
  });

  it("rejects malformed request bodies with 400 and no side effect", async () => {
    const r = await sim("/hr/v1/workers", { body: { employeeRef: "S002" }, key: "k-bad" });
    expect(r.status).toBe(400);
    expect((await ledger({ employeeRef: "S002" })).length).toBe(0);
  });
});

describe("HR", () => {
  it("creates a worker, verifies documents on the 2nd poll, enrolls orientation, activates", async () => {
    const w = await simJson<{ id: string; status: string }>("/hr/v1/workers", { body: workerBody("H001"), key: "H001:hr.create-worker" });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ status: "preboarding", id: expect.stringMatching(/^wkr_/) });

    // activation before verification is a genuine 409
    expect((await sim(`/hr/v1/workers/${w.body.id}/activation`, { body: {}, key: "H001:hr.activate-worker" })).status).toBe(409);

    const dv = await simJson<{ id: string; status: string }>(`/hr/v1/workers/${w.body.id}/document-verifications`, {
      body: { documents: ["offer_docs", "i9_section1"] },
      key: "H001:hr.start-document-verification",
    });
    expect(dv.status).toBe(202);
    expect(dv.body.status).toBe("pending");
    expect((await simJson(`/hr/v1/document-verifications/${dv.body.id}`)).body).toMatchObject({ status: "pending" });
    expect((await simJson(`/hr/v1/document-verifications/${dv.body.id}`)).body).toMatchObject({ status: "verified" });
    expect((await simJson(`/hr/v1/document-verifications/${dv.body.id}`)).body).toMatchObject({ status: "verified" });

    const tooEarly = await simJson(`/hr/v1/orientation-enrollments`, { body: { workerId: w.body.id, sessionDate: "2026-10-01" }, key: "H001:early" });
    expect(tooEarly.status).toBe(422);
    const orn = await simJson(`/hr/v1/orientation-enrollments`, { body: { workerId: w.body.id, sessionDate: "2026-11-02" }, key: "H001:hr.enroll-orientation" });
    expect(orn.status).toBe(201);
    expect(orn.body).toMatchObject({ sessionDate: "2026-11-02" });

    const act = await simJson(`/hr/v1/workers/${w.body.id}/activation`, { body: {}, key: "H001:hr.activate-worker" });
    expect(act).toMatchObject({ status: 200, body: { status: "active" } });
    expect((await simJson(`/hr/v1/workers/${w.body.id}`)).body).toMatchObject({ status: "active", employeeRef: "H001" });
    expect((await ledger({ employeeRef: "H001" })).map((l) => l.operation)).toEqual([
      "create-worker",
      "start-document-verification",
      "enroll-orientation",
      "activate-worker",
    ]);
  });

  it("returns a genuine 422 for an invalid cost center and 404 for unknown workers", async () => {
    const bad = await simJson<{ error: { field: string } }>("/hr/v1/workers", { body: workerBody("H002", { costCenter: "1100" }), key: "H002:hr.create-worker" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.field).toBe("costCenter");
    expect((await sim(`/hr/v1/workers/wkr_missing/document-verifications`, { body: { documents: ["x"] }, key: "k404" })).status).toBe(404);
    expect((await sim(`/hr/v1/workers/wkr_missing`)).status).toBe(404);
  });
});

describe("IT", () => {
  it("creates an account, assigns licenses, orders a device that advances one state per poll", async () => {
    const { accountId } = await workerAndAccount("I001");
    const lic = await simJson<{ assigned: string[] }>(`/it/v1/accounts/${accountId}/licenses`, {
      body: { bundle: "ft-engineering", privileged: true, approvalRef: "apr:I001:manager_approval:1" },
      key: "I001:it.assign-licenses",
    });
    expect(lic.status).toBe(201);
    expect(lic.body.assigned).toContain("privileged-admin");
    const acct = await simJson<{ licenses: string[]; status: string }>(`/it/v1/accounts/${accountId}`);
    expect(acct.body.status).toBe("active");
    expect(acct.body.licenses).toContain("source-control");

    const order = await simJson<{ id: string; status: string }>("/it/v1/device-orders", {
      body: { accountId, profile: "engineering", shipTo: "San Jose HQ" },
      key: "I001:it.order-device",
    });
    expect(order).toMatchObject({ status: 202, body: { status: "ordered" } });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push((await simJson<{ status: string }>(`/it/v1/device-orders/${order.body.id}`)).body.status);
    expect(seen).toEqual(["processing", "shipped", "delivered", "delivered"]);
  });

  it("rejects a bundle not allowed for the employment type, and privileged access without approval", async () => {
    const { accountId } = await workerAndAccount("I002", "contractor");
    const wrong = await simJson<{ error: { field: string } }>(`/it/v1/accounts/${accountId}/licenses`, {
      body: { bundle: "ft-engineering", privileged: false },
      key: "I002:it.assign-licenses",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.field).toBe("licenseBundle");
    const priv = await simJson<{ error: { field: string } }>(`/it/v1/accounts/${accountId}/licenses`, {
      body: { bundle: "contractor-basic", privileged: true },
      key: "I002:priv",
    });
    expect(priv.status).toBe(422);
    expect((await sim("/it/v1/device-orders", { body: { accountId: "acct_missing", profile: "standard", shipTo: "x" }, key: "k" })).status).toBe(404);
  });
});

describe("Facilities", () => {
  it("assigns a desk on site and a remote kit for remote employees", async () => {
    const desk = await simJson<{ kind: string; deskId?: string }>("/facilities/v1/workspace-assignments", {
      body: { employeeRef: "F001", workMode: "onsite", site: "Austin", preference: "team-neighborhood" },
      key: "F001:facilities.assign-workspace",
    });
    expect(desk.status).toBe(201);
    expect(desk.body.kind).toBe("desk");
    expect(desk.body.deskId).toMatch(/^AUS-/);
    const kit = await simJson<{ kind: string; deskId?: string }>("/facilities/v1/workspace-assignments", {
      body: { employeeRef: "F002", workMode: "remote", site: "Remote (US)", preference: "team-neighborhood" },
      key: "F002:facilities.assign-workspace",
    });
    expect(kit.body).toMatchObject({ kind: "remote_kit" });
    expect(kit.body.deskId).toBeUndefined();
  });

  it("issues a badge that goes requested -> printed -> active, and rejects a missing photo", async () => {
    const noPhoto = await simJson<{ error: { field: string } }>("/facilities/v1/badges", {
      body: { employeeRef: "F003", photoOnFile: false, accessLevel: "standard" },
      key: "F003:facilities.issue-badge",
    });
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.error.field).toBe("photoOnFile");
    const b = await simJson<{ id: string; status: string }>("/facilities/v1/badges", {
      body: { employeeRef: "F003", photoOnFile: true, accessLevel: "standard" },
      key: "F003:facilities.issue-badge",
    });
    expect(b).toMatchObject({ status: 202, body: { status: "requested" } });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) seen.push((await simJson<{ status: string }>(`/facilities/v1/badges/${b.body.id}`)).body.status);
    expect(seen).toEqual(["printed", "active", "active"]);
  });
});
