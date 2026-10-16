// The chart colors must exist in every theme: the light defaults under :root,
// the system dark scheme (unless the page forces light), and a forced dark theme.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../src/web/styles/tokens.css", import.meta.url), "utf8");

/** The declarations inside the first block that follows `selector` (matching braces). */
function block(selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no ${selector}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selector}`);
}

const TOKENS = ["--chart-blocked", "--chart-waiting", "--chart-running"];
const SELECTORS = { light: ":root {", systemDark: ':root:not([data-theme="light"])', forcedDark: ':root[data-theme="dark"]' };

describe("chart color tokens", () => {
  for (const [theme, selector] of Object.entries(SELECTORS)) {
    it(`are defined for the ${theme} theme`, () => {
      const decl = block(selector);
      for (const t of TOKENS) expect(decl, `${t} in ${selector}`).toMatch(new RegExp(`${t}:\\s*#[0-9a-f]{6};`));
    });
  }

  it("put the system dark scheme inside prefers-color-scheme: dark", () => {
    expect(block("@media (prefers-color-scheme: dark)")).toContain(':root:not([data-theme="light"])');
  });

  it("use the same dark values in both dark selectors", () => {
    const value = (selector: string, t: string) => new RegExp(`${t}:\\s*(#[0-9a-f]{6});`).exec(block(selector))?.[1];
    for (const t of TOKENS) expect(value(SELECTORS.systemDark, t)).toBe(value(SELECTORS.forcedDark, t));
  });
});
