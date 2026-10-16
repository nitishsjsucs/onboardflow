import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../../src/web/api/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(body: string, status = 200, headers: Record<string, string> = {}) {
  globalThis.fetch = vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("apiFetch", () => {
  it("rethrows an AbortError unchanged, so query cancellation still works", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    globalThis.fetch = vi.fn(async () => {
      throw abort;
    }) as unknown as typeof fetch;
    expect(await caught(apiFetch("/api/cases/E001"))).toBe(abort);
  });

  it("turns a failed fetch into ApiError(0, network)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const e = await caught(apiFetch("/api/cases/E001"));
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(0);
    expect((e as ApiError).code).toBe("network");
  });

  it("turns a body that is not JSON into non_json_response, for an error status and for a 2xx", async () => {
    respond("<html>Bad gateway</html>", 502, { "X-Request-Id": "rid-502" });
    const bad = (await caught(apiFetch("/api/employees"))) as ApiError;
    expect([bad.status, bad.code, bad.requestId]).toEqual([502, "non_json_response", "rid-502"]);
    respond('{"round": 2', 200);
    const garbled = (await caught(apiFetch("/api/cases/E001/stages/intake/retry", { method: "POST", body: {} }))) as ApiError;
    expect([garbled.status, garbled.code]).toEqual([200, "non_json_response"]);
  });

  it("keeps the server's error code, message and request id", async () => {
    respond(JSON.stringify({ error: { code: "stage_not_blocked", message: "stage is active", requestId: "r9" } }), 409);
    const e = (await caught(apiFetch("/api/x", { method: "POST", body: {} }))) as ApiError;
    expect([e.status, e.code, e.message, e.requestId]).toEqual([409, "stage_not_blocked", "stage is active", "r9"]);
  });

  it("does not follow a redirect: an Access sign-in redirect is a 401, not a network error", async () => {
    const init: RequestInit[] = [];
    // what a browser hands back for redirect: "manual" (status 0, no headers or body)
    globalThis.fetch = vi.fn(async (_url: string, i: RequestInit) => {
      init.push(i);
      return { type: "opaqueredirect", status: 0, ok: false, headers: new Headers(), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    const e = (await caught(apiFetch("/api/cases/E001"))) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code]).toEqual([401, "unauthenticated"]);
    expect(init[0]!.redirect).toBe("manual");
  });

  it("returns null for an empty 2xx body", async () => {
    respond("", 200);
    expect(await apiFetch("/api/x")).toBeNull();
  });
});
