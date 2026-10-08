import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, json } from "../helpers/api.ts";
import { emailOf } from "../helpers/auth.ts";

const devLogins = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'dev.login'").first<{ n: number }>())?.n ?? 0;

describe("same-origin checks on /dev mutations", () => {
  it("rejects /dev/login without Origin, with a foreign Origin, or without X-OnboardFlow, and changes nothing", async () => {
    const email = await emailOf("E002");
    const before = await devLogins();
    const noOrigin = await call("/dev/login", { body: { email }, origin: null });
    const foreign = await call("/dev/login", { body: { email }, origin: "https://evil.example" });
    const noHeader = await call("/dev/login", { body: { email }, csrf: false });
    for (const res of [noOrigin, foreign, noHeader]) {
      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect((await json<{ error: { code: string } }>(noOrigin)).error.code).toBe("bad_origin");
    expect((await json<{ error: { code: string } }>(foreign)).error.code).toBe("bad_origin");
    expect((await json<{ error: { code: string } }>(noHeader)).error.code).toBe("csrf_header_missing");
    expect(await devLogins()).toBe(before);
  });

  it("rejects a cross-site /dev/logout", async () => {
    const res = await call("/dev/logout", { method: "POST", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("dev cookie", () => {
  it("is HttpOnly, SameSite=Strict, Path=/, Max-Age=28800 and not Secure on http", async () => {
    const res = await call("/dev/login", { body: { email: await emailOf("E002") } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^CF_Authorization=[\w-]+\.[\w-]+\.[\w-]+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=28800");
    expect(cookie).not.toContain("Secure");
    const { token } = await json<{ token: string }>(res);
    // the minted token authenticates through the cookie fallback
    const me = await call("/api/me", { headers: { Cookie: `CF_Authorization=${token}` } });
    expect(me.status).toBe(200);
  });

  it("adds Secure when the request is https", async () => {
    const { exports } = await import("cloudflare:workers");
    const res = await exports.default.fetch(
      new Request("https://localhost/dev/login", {
        method: "POST",
        headers: { Origin: "https://localhost", "X-OnboardFlow": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ email: await emailOf("E002") }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("; Secure");
  });

  it("logout clears the cookie", async () => {
    const res = await call("/dev/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
