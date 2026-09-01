/**
 * The DNS Doctor OpenClaw plugin — a thin client in front of the public DNS
 * Doctor REST API.
 *
 * It holds no diagnosis logic of its own. Every tool is one HTTP call whose
 * response is relayed **verbatim**: the record strings, signup URLs and verdicts
 * in those payloads are authored server-side by the fixengine, and rewriting one
 * here would break the product's central invariant (an LLM — or a client — never
 * composes an authoritative record).
 *
 * Nothing in `src/` authors a tool name, description or schema. The definitions
 * are read from `tools.json`, which is generated from the hosted MCP server's
 * own `list_tools()` and byte-pinned by
 * `backend/tests/mcp_server/test_tools_fixture.py`; the plugin's identity and
 * config schema are read from `openclaw.plugin.json`, whose `contracts.tools`
 * array is generated from the same fixture. So the only thing this file decides
 * is which endpoint each tool calls and how the answer is shaped for the agent.
 */

import { readFileSync } from "node:fs";

import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";

import { DnsDoctorApi, type PluginSettings } from "./api.js";
import { DEFAULT_REPORT_FILENAME, ROUTES, reportPath } from "./routes.js";

/** One entry of `tools.json` — the hosted server's own tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** The plugin manifest's shape, as far as this file reads it. */
interface PluginManifest {
  id: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown>;
}

/**
 * Both files sit at the package root — one level up from `src/` (tests, run from
 * source) and from `dist/` (the built entry the gateway loads), so the same
 * relative URL resolves in either. They ship in `package.json#files`; a missing
 * one throws rather than degrading to an empty tool list, because a plugin that
 * silently registers nothing is indistinguishable from a healthy one.
 */
function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as T;
}

const MANIFEST: PluginManifest = readJson<PluginManifest>("openclaw.plugin.json");

const TOOLS: ToolDefinition[] = (() => {
  const parsed = readJson<unknown>("tools.json");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("tools.json is not a non-empty array of tool definitions");
  }
  return parsed as ToolDefinition[];
})();

/** The tool names, for the dispatch table's coverage check. */
export function toolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

/**
 * The UI label for a tool — derived, never written.
 *
 * A label is display chrome, not a definition, so it is generated mechanically
 * from the pinned name (`scan_domain` → "Scan domain"). Hand-written labels
 * would be a second place a tool's meaning lives, free to drift from the
 * description the backend owns.
 */
export function toolLabel(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Read this plugin's config out of a gateway config snapshot.
 *
 * Walked as `unknown` rather than typed: the per-plugin entry map has moved
 * between gateway versions, and a missing key must degrade to the environment
 * fallback (`DNSDOCTOR_API_TOKEN`/`DNSDOCTOR_API_BASE`) instead of throwing. A
 * plugin that crashes on an unfamiliar config shape takes its tools with it.
 */
export function settingsFromConfig(config: unknown): PluginSettings {
  const entries = (config as { plugins?: { entries?: Record<string, unknown> } } | undefined)
    ?.plugins?.entries;
  const entry = entries?.[MANIFEST.id] as { config?: Record<string, unknown> } | undefined;
  const values = entry?.config;
  if (values === undefined) return {};
  const read = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  return { apiToken: read("apiToken"), apiBase: read("apiBase") };
}

/**
 * Run one tool and return the API's parsed body, untouched.
 *
 * `signal` is the gateway's own cancellation token, threaded down to `fetch`.
 * Unlike the npm client — a short-lived stdio process the OS reaped on exit —
 * this runs inside a long-lived multi-plugin gateway, so a request nobody is
 * waiting for any more would otherwise keep running to undici's multi-minute
 * default and keep spending the caller's per-IP scan budget.
 */
export async function callTool(
  settings: PluginSettings,
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const route = ROUTES[name];
  if (route === undefined) {
    throw new Error(`unknown tool '${name}'`);
  }
  const api = new DnsDoctorApi(settings, signal);
  if (route.kind === "report") {
    return api.getJson(reportPath(requireString(args, "domain")));
  }
  if (route.kind === "query") {
    return api.getWithQuery(route.path, args);
  }
  if (route.kind === "upload") {
    const content = requireString(args, "content_base64");
    const filename = args["filename"];
    return api.postFile(
      route.path,
      route.field,
      typeof filename === "string" && filename.trim() !== "" ? filename : DEFAULT_REPORT_FILENAME,
      content,
    );
  }
  return api.postJson(route.path, args);
}

function asArgs(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/**
 * Build the 15 `AgentTool`s from the pinned fixture.
 *
 * `parameters` takes the fixture's `inputSchema` as-is: TypeBox schemas ARE
 * plain JSON Schema objects, so the cast is a type assertion over data that is
 * already the right shape — authoring a second, TypeBox-flavoured copy of each
 * schema is exactly the drift `tools.json` exists to prevent.
 *
 * `resolveSettings` is a getter, not a value: the gateway hands long-lived tool
 * definitions a `getRuntimeConfig()` so a config edit applies without a reload.
 */
export function buildTools(resolveSettings: () => PluginSettings): AnyAgentTool[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as AnyAgentTool["parameters"],
    label: toolLabel(tool.name),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      // Throws on any non-2xx — `AgentTool.execute`'s documented contract is
      // "throw on failure instead of encoding errors in `content`", and the
      // thrown text is the API's own (the 401 monitoring refusal included).
      const body = await callTool(resolveSettings(), tool.name, asArgs(params), signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        details: body,
      };
    },
  }));
}

/** Every fixture tool has a route — a missing one would 'unknown tool' at runtime. */
export function unroutedTools(): string[] {
  return toolNames().filter((name) => ROUTES[name] === undefined);
}

/**
 * The tool factory the gateway calls: all 16 tools, built from one context.
 *
 * All three config sources the context may carry are consulted, freshest first:
 * `getRuntimeConfig()` (a getter, so a config edit applies without a reload),
 * then the `runtimeConfig` snapshot, then the unresolved `config`. Every one of
 * them is optional on `OpenClawPluginToolContext`, and reading only the first
 * two would silently drop a configured `apiToken` on a gateway that populates
 * the third — `get_alerts`/`get_readiness` would then 401 with guidance telling
 * the operator to set a token they already set.
 *
 * The fallback is on the RESOLVED settings, not on the source object being
 * present: `settingsFromConfig`'s own contract is that the per-plugin entry map
 * "has moved between gateway versions", so a freshest source that IS populated
 * but carries the entry somewhere else resolves to `{}` — stopping there would
 * drop the token exactly as skipping a source would.
 */
export function toolFactory(ctx: OpenClawPluginToolContext): AnyAgentTool[] {
  return buildTools(() => {
    for (const source of [ctx.getRuntimeConfig?.(), ctx.runtimeConfig, ctx.config]) {
      const settings = settingsFromConfig(source);
      if (settings.apiToken !== undefined || settings.apiBase !== undefined) return settings;
    }
    return {};
  });
}

export function register(api: OpenClawPluginApi): void {
  api.registerTool(toolFactory);
}

// The annotation is required, not decorative: the inferred entry type reaches
// into openclaw's internal chunk file names, which `tsc --declaration` cannot
// name portably (TS2742).
const entry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: MANIFEST.id,
  name: MANIFEST.name,
  description: MANIFEST.description,
  configSchema: () => buildJsonPluginConfigSchema(MANIFEST.configSchema as never),
  register,
});

export default entry;
