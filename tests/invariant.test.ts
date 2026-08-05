/**
 * Structural guards — this plugin's half of the project-wide invariant that an
 * authoritative record string is only ever *relayed*, never composed, and that
 * a tool's meaning lives in exactly one place (the backend-pinned fixture).
 *
 * The plugin holds no fixengine, so the failure mode is a well-meaning literal:
 * a "helpful" default record in an error message, a re-typed description that
 * slowly disagrees with the hosted server's, a second origin quietly sending
 * traffic elsewhere. All three checks read the real `src/` files rather than
 * trusting review — the same approach as `@dnsdoctor/mcp`'s invariant test.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "../src/index.js";

const SRC_DIR = new URL("../src/", import.meta.url);

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, SRC_DIR), "utf8") }));
}

function fixture(): ToolDefinition[] {
  return JSON.parse(
    readFileSync(new URL("../tools.json", import.meta.url), "utf8"),
  ) as ToolDefinition[];
}

/** Record-shaped literals: if one of these appears, something is being composed. */
const RECORD_PATTERNS: RegExp[] = [
  /v=spf1/i,
  /v=DMARC1/i,
  /\bp=(none|quarantine|reject)\b/i,
  /\brua=/i,
];

describe("no record composition in src/", () => {
  const files = sourceFiles();

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const pattern of RECORD_PATTERNS) {
    it(`contains no ${pattern.source} literal`, () => {
      const offenders = files.filter((file) => pattern.test(file.text)).map((file) => file.name);
      expect(offenders).toEqual([]);
    });
  }
});

describe("one home for the origin", () => {
  it("mentions the hosted origin only in api.ts", () => {
    // A second origin is how traffic silently leaves the public API — and how
    // the UA attribution this plugin exists to measure stops being readable.
    const offenders = sourceFiles()
      .filter((file) => file.name !== "api.ts" && file.text.includes("https://dnsdoctor.dev"))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});

describe("no tool copy in src/", () => {
  const sources = sourceFiles()
    .map((file) => file.text)
    .join("\n");

  it("names no tool description — the fixture is the only source", () => {
    const leaked = fixture().filter((tool) => sources.includes(tool.description.slice(0, 40)));
    expect(leaked.map((tool) => tool.name)).toEqual([]);
  });

  it("holds no re-typed schema property names outside the fixture", () => {
    // `src/` reads `inputSchema` straight off the fixture; a hand-written
    // `properties: {...}` block anywhere here would be a second schema free to
    // drift from the backend's.
    const offenders = sourceFiles()
      .filter((file) => /\bproperties\s*:\s*\{/.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});

describe("the package carries everything the plugin reads at runtime", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files: string[];
    openclaw: { extensions: string[] };
  };

  it("ships both fixtures — without them the plugin has no tools and no identity", () => {
    // `src/index.ts` throws on a missing file rather than registering nothing:
    // a plugin with an empty tool list is indistinguishable from a healthy one.
    expect(pkg.files).toContain("tools.json");
    expect(pkg.files).toContain("openclaw.plugin.json");
    expect(pkg.files).toContain("dist");
  });

  it("points the gateway at the built entry", () => {
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
  });
});
