/**
 * The route table against the pinned fixture, and the fixture's schemas against
 * the validator the gateway actually runs them through.
 *
 * Two different failure modes: a tool the backend added but this table never
 * routed would register fine and then throw "unknown tool" on first use, and a
 * schema shape TypeBox rejects would take the whole tool registration down at
 * load time — both invisible until a user hits them.
 */

import { existsSync, readFileSync } from "node:fs";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";

import { toolNames, unroutedTools, type ToolDefinition } from "../src/index.js";
import { ROUTES, reportPath } from "../src/routes.js";

const TOOLS = JSON.parse(
  readFileSync(new URL("../tools.json", import.meta.url), "utf8"),
) as ToolDefinition[];

const MANIFEST = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { contracts: { tools: string[] } };

/**
 * The npm client's table is the parity reference — both speak the same API.
 *
 * Sibling-package path, so it exists only in the monorepo: this package is the
 * repo ROOT of the published `dnsdoctor/openclaw-plugin` snapshot, where the
 * whole `integrations/` tree is gone. The check skips there rather than failing
 * — the same "missing sibling → skip" shape the backend pin uses — because that
 * snapshot's CI is a public health signal and must not go red on an absent file.
 * Cross-client parity is owned in the monorepo either way, by this test and by
 * `backend/tests/mcp_server/test_client_routes.py::test_the_clients_dispatch_identically`.
 */
const CLIENT_SRC = new URL("../../claude-plugin/src/index.ts", import.meta.url);

/** `{tool: {kind, path?}}` parsed out of the npm client's `ROUTES` literal. */
function clientRoutes(source: string): Record<string, { kind: string; path?: string }> {
  const block = /const ROUTES: Record<string, Route> = \{([\s\S]*?)\n\};/.exec(source);
  if (block === null) throw new Error("could not locate the npm client's ROUTES literal");
  const table: Record<string, { kind: string; path?: string }> = {};
  for (const entry of block[1].matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
    const body = entry[2];
    const kind = /kind:\s*"([^"]+)"/.exec(body);
    const path = /path:\s*"([^"]+)"/.exec(body);
    if (kind === null) throw new Error(`no kind for '${entry[1]}' in the npm client's ROUTES`);
    table[entry[1]] = path === null ? { kind: kind[1] } : { kind: kind[1], path: path[1] };
  }
  return table;
}

describe("route table ↔ tools.json", () => {
  it("routes exactly the fixture's tools — no missing, no extra", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(toolNames().slice().sort());
  });

  it("leaves no tool unrouted", () => {
    expect(unroutedTools()).toEqual([]);
  });

  it("carries the 16 tools the backend publishes", () => {
    expect(TOOLS).toHaveLength(16);
  });

  it.skipIf(!existsSync(CLIENT_SRC))(
    "dispatches every tool exactly as the npm client, which is pinned to the real app",
    () => {
      // Not a re-derivation of the backend's routes (the pytest pin owns that) —
      // this catches the two tables drifting apart, which would leave one
      // surface's users 404ing while the other stays green. Compared per TOOL,
      // not as a bag of path strings: swapping two tools' paths keeps the same
      // set of strings while sending every caller to the wrong endpoint.
      const client = clientRoutes(readFileSync(CLIENT_SRC, "utf8"));
      const ours = Object.fromEntries(
        Object.entries(ROUTES).map(([name, route]) => [
          name,
          "path" in route ? { kind: route.kind, path: route.path } : { kind: route.kind },
        ]),
      );
      expect(ours).toEqual(client);
    },
  );
});

describe("the manifest's tool contract", () => {
  // `contracts.tools` is what makes the gateway activate this plugin lazily: a
  // name missing there is a tool that never wakes the plugin, and a name that
  // no longer exists is a contract the plugin cannot honour. Regenerated from
  // the fixture and byte-pinned by the backend suite — re-asserted here so the
  // published snapshot, which has no backend beside it, still catches a hand-edit.
  it("names exactly the tools this plugin registers", () => {
    expect(MANIFEST.contracts.tools).toEqual(toolNames().slice().sort());
  });
});

describe("the report path", () => {
  it("encodes the domain it is given", () => {
    expect(reportPath("example.com")).toBe("/api/v1/report/example.com");
    expect(reportPath("a/b?c")).toBe("/api/v1/report/a%2Fb%3Fc");
  });
});

describe("schema acceptance", () => {
  // The one seam where the gateway's runtime could reject what the backend
  // publishes: `parameters` is handed to TypeBox as-is, so a JSON Schema
  // construct it cannot compile fails at registration, not at call time.
  for (const tool of TOOLS) {
    it(`compiles ${tool.name}'s inputSchema`, () => {
      const validator = Compile(tool.inputSchema);
      expect(typeof validator.Check).toBe("function");
      // A validator that accepts everything would pass the line above while
      // proving nothing; every tool schema is an object schema.
      expect(validator.Check("not an object")).toBe(false);
    });
  }
});
