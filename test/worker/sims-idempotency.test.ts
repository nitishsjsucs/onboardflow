import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ledger, sim, simJson, workerAndAccount, workerBody } from "../helpers/sims.ts";

type Case = {
  system: string;
  operation: string;
  path: (ref: string) => Promise<string>;
  good: (ref: string) => unknown;
  other: (ref: string) => unknown;
  invalid: (ref: string) => unknown;
};

const accounts = new Map<string, string>();
async function accountFor(ref: string) {
  if (!accounts.has(ref)) accounts.set(ref, (await workerAndAccount(ref, "contractor")).accountId);
  return accounts.get(ref)!;
}

const CASES: Case[] = [
  {
    system: "hr",
    operation: "create-worker",
    path: async () => "/hr/v1/workers",
    good: (ref) => workerBody(ref),
    other: (ref) => workerBody(ref, { orgUnit: "Sales" }),
    invalid: (ref) => workerBody(ref, { costCenter: "bad" }),
  },
  {
    system: "it",
    operation: "assign-licenses",
    path: async (ref) => `/it/v1/accounts/${await accountFor(ref)}/licenses`,
    good: () => ({ bundle: "contractor-basic", privileged: false }),
    other: () => ({ bundle: "contractor-basic", privileged: true, approvalRef: "apr:x" }),
    invalid: () => ({ bundle: "ft-standard", privileged: false }),
  },
  {
    system: "facilities",
    operation: "issue-badge",
    path: async () => "/facilities/v1/badges",
    good: (ref) => ({ employeeRef: ref, photoOnFile: true, accessLevel: "standard" }),
    other: (ref) => ({ employeeRef: ref, photoOnFile: true, accessLevel: "restricted" }),
    invalid: (ref) => ({ employeeRef: ref, photoOnFile: false, accessLevel: "standard" }),
  },
];

const ops = (system: string, operation: string, ref: string) => ledger({ system, operation, employeeRef: ref });

for (const c of CASES) {
  describe(`${c.system} ${c.operation}`, () => {
    const R = (n: number) => `${c.system.slice(0, 1).toUpperCase()}${700 + n}`;

    it("requires an Idempotency-Key on POST", async () => {
      const ref = R(1);
      const res = await sim(await c.path(ref), { body: c.good(ref), key: null });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
      expect(await ops(c.system, c.operation, ref)).toHaveLength(0);
    });

    it("replays the stored response with Idempotent-Replayed and keeps one ledger row", async () => {
      const ref = R(2);
      const path = await c.path(ref);
      const first = await simJson(path, { body: c.good(ref), key: `${ref}:${c.operation}` });
      const second = await simJson(path, { body: c.good(ref), key: `${ref}:${c.operation}` });
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(await ops(c.system, c.operation, ref)).toHaveLength(1);
    });

    it("answers 422 idempotency_key_reuse for a different body with the same key", async () => {
      const ref = R(3);
      const path = await c.path(ref);
      await simJson(path, { body: c.good(ref), key: `${ref}:${c.operation}` });
      const reuse = await simJson(path, { body: c.other(ref), key: `${ref}:${c.operation}` });
      expect(reuse.status).toBe(422);
      expect(reuse.body).toMatchObject({ error: { code: "idempotency_key_reuse" } });
      expect(await ops(c.system, c.operation, ref)).toHaveLength(1);
    });

    it("does not cache a genuine 422: the fixed request succeeds with the same key", async () => {
      const ref = R(4);
      const path = await c.path(ref);
      const bad = await simJson(path, { body: c.invalid(ref), key: `${ref}:${c.operation}` });
      expect(bad.status).toBe(422);
      expect(await ops(c.system, c.operation, ref)).toHaveLength(0);
      const fixed = await simJson(path, { body: c.good(ref), key: `${ref}:${c.operation}` });
      expect(fixed.status).toBeLessThan(300);
      expect(fixed.replayed).toBe(false);
      expect(await ops(c.system, c.operation, ref)).toHaveLength(1);
    });

    it("executes once for 5 concurrent requests with one key: 1 ledger row, 4 replays", async () => {
      const ref = R(5);
      const path = await c.path(ref);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => simJson(path, { body: c.good(ref), key: `${ref}:${c.operation}` })),
      );
      expect(results.filter((r) => r.replayed)).toHaveLength(4);
      expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(await ops(c.system, c.operation, ref)).toHaveLength(1);
    });

    // What this checks: a caller that gives up never leaves a partial set of rows (idempotency row,
    // resource, ledger row). Three timings: aborted before dispatch, aborted after dispatch while the
    // request body is being read (the body is held open half sent), and not aborted. An
    // abort cannot be timed to land inside the commit itself (workerd's clock does not advance during
    // execution, and the commit is one D1 batch call); atomicity there is the batch transaction's.
    it("leaves all three rows or none when the caller aborts before dispatch, while its body is read, or not at all", async () => {
      const rowsOf = async (ref: string) => {
        const key = `${ref}:${c.operation}`;
        const idem = await env.DB.prepare("SELECT COUNT(*) AS n FROM sim_idempotency WHERE system = ? AND idempotency_key = ?").bind(c.system, key).first<{ n: number }>();
        const led = await ops(c.system, c.operation, ref);
        const res = await env.DB.prepare("SELECT COUNT(*) AS n FROM sim_resources s JOIN sim_side_effects l ON l.resource_id = s.id WHERE l.idempotency_key = ?").bind(key).first<{ n: number }>();
        return [idem?.n ?? -1, led.length, res?.n ?? -1];
      };

      // 1. aborted before dispatch
      const before = R(10);
      const beforePath = await c.path(before);
      const ac = new AbortController();
      ac.abort();
      await expect(sim(beforePath, { body: c.good(before), key: `${before}:${c.operation}`, signal: ac.signal })).rejects.toThrow();

      // 2. aborted mid-flight: the request is dispatched and its body is being read when the caller gives up
      const mid = R(11);
      const midPath = await c.path(mid);
      const json = JSON.stringify(c.good(mid));
      const enc = new TextEncoder();
      let pulled = false;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(json.slice(0, Math.floor(json.length / 2))));
        },
        pull() {
          pulled = true;
          return new Promise<void>(() => {}); // the second half never comes
        },
      });
      const midAbort = new AbortController();
      const inFlight = exports.default.fetch(
        new Request(`http://localhost/sim${midPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Sim-Api-Key": env.SIM_API_KEY, "Idempotency-Key": `${mid}:${c.operation}` },
          body,
        }),
        { signal: midAbort.signal },
      );
      const settled = inFlight.then(
        () => "answered",
        () => "aborted",
      );
      // wait until the reader has pulled past the first chunk, then give up
      for (let i = 0; i < 100 && !pulled; i++) await new Promise((r) => setTimeout(r, 10));
      expect(pulled, "the request body was being read").toBe(true);
      midAbort.abort();
      expect(await settled).toBe("aborted");

      // 3. not aborted
      const done = R(12);
      expect((await sim(await c.path(done), { body: c.good(done), key: `${done}:${c.operation}` })).status).toBeLessThan(300);

      await new Promise((r) => setTimeout(r, 200));
      expect(await rowsOf(before), before).toEqual([0, 0, 0]);
      expect(await rowsOf(mid), mid).toEqual([0, 0, 0]);
      expect(await rowsOf(done), done).toEqual([1, 1, 1]);
    });
  });
}
