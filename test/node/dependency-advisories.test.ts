// Pins the facts behind README "Dependency advisories". agents 0.27.0 pinned @modelcontextprotocol/sdk
// 1.30.0 and /client 2.0.0, which carry GHSA-6qxp-vccf-f47h (the MCP OAuth client may send stored
// credentials to an authorization server the MCP server chooses); agents 0.28.1 pins the fixed releases
// and is installed now. The advisory concerned the OAuth client the Agents SDK creates only for MCP servers
// registered with addMcpServer(). OnboardFlow keeps never importing MCP and never registering a server, so
// a future MCP advisory of that kind stays unreachable too; if that changes, this test fails.
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

  it("the MCP packages are present only as the exact peers the installed agents release requires", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    const agents = JSON.parse(readFileSync("node_modules/agents/package.json", "utf8")) as { version: string; peerDependencies: Record<string, string> };
    expect(agents.version).toBe(pkg.dependencies.agents);
    for (const name of ["@modelcontextprotocol/client", "@modelcontextprotocol/sdk", "@modelcontextprotocol/server"]) {
      expect(pkg.dependencies[name], name).toBe(agents.peerDependencies[name]);
    }
  });

  it("the installed MCP SDK releases include the GHSA-6qxp-vccf-f47h fix (sdk 1.31.0, client 2.2.0 or later)", () => {
    const version = (name: string) => (JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")) as { version: string }).version.split(".").map(Number);
    const atLeast = (v: number[], min: number[]) => v[0]! > min[0]! || (v[0] === min[0] && (v[1]! > min[1]! || (v[1] === min[1] && v[2]! >= min[2]!)));
    expect(atLeast(version("@modelcontextprotocol/sdk"), [1, 31, 0]), "@modelcontextprotocol/sdk").toBe(true);
    expect(atLeast(version("@modelcontextprotocol/client"), [2, 2, 0]), "@modelcontextprotocol/client").toBe(true);
  });
});
