// Pins the facts behind the npm audit triage in README ("Dependency advisories"): the three high
// advisories (GHSA-6qxp-vccf-f47h in @modelcontextprotocol/sdk 1.30.0 and /client 2.0.0, and agents
// 0.27.0 through them) concern the MCP OAuth client, which the Agents SDK creates only for MCP servers
// registered with addMcpServer(). OnboardFlow must keep never importing MCP and never registering a server;
// if that changes, the advisories become reachable and this test fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const sources = ["src", "scripts", "eval"].flatMap(files);

describe("MCP advisories stay unreachable", () => {
  it("no source file imports an @modelcontextprotocol package", () => {
    expect(sources.filter((f) => readFileSync(f, "utf8").includes("@modelcontextprotocol"))).toEqual([]);
  });

  it("no agent registers an MCP server or touches the SDK's MCP client", () => {
    const uses = sources.filter((f) => /\baddMcpServer\b|\bremoveMcpServer\b|\.mcp\.|\bMCPClientManager\b/.test(readFileSync(f, "utf8")));
    expect(uses).toEqual([]);
  });

  it("the MCP packages are present only as the exact peers agents 0.27.0 requires", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    const agents = JSON.parse(readFileSync("node_modules/agents/package.json", "utf8")) as { version: string; peerDependencies: Record<string, string> };
    expect(agents.version).toBe(pkg.dependencies.agents);
    for (const name of ["@modelcontextprotocol/client", "@modelcontextprotocol/sdk", "@modelcontextprotocol/server"]) {
      expect(pkg.dependencies[name], name).toBe(agents.peerDependencies[name]);
    }
  });
});
