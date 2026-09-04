/**
 * What an agent actually experiences: one tool call in, one HTTP request out,
 * the API's own answer back — or its own error text thrown.
 *
 * `fetch` is mocked throughout; nothing here touches the network. The tokens are
 * placeholders (`dnsd_YOUR_TOKEN` and friends) — never a real one.
 */

import { readFileSync } from "node:fs";

import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_API_BASE } from "../src/api.js";
import entry, {
  buildTools,
  callTool,
  register,
  settingsFromConfig,
  toolFactory,
  toolLabel,
  toolNames,
} from "../src/index.js";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { id: string; name: string; description: string };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.DNSDOCTOR_API_BASE;
  delete process.env.DNSDOCTOR_API_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DNSDOCTOR_API_BASE;
  delete process.env.DNSDOCTOR_API_TOKEN;
});

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call as [string, RequestInit];
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("dispatch", () => {
  it("posts a json tool's arguments unchanged", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await callTool({}, "scan_domain", { domain: "Example.COM" });
    const [url, init] = lastCall();
    expect(url).toBe(`${DEFAULT_API_BASE}/api/v1/scan`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ domain: "Example.COM" }));
  });

  it("puts the report tool's domain in the path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await callTool({}, "get_report", { domain: "example.com" });
    const [url, init] = lastCall();
    expect(url).toBe(`${DEFAULT_API_BASE}/api/v1/report/example.com`);
    expect(init.method).toBe("GET");
  });

  it("refuses a report call with no domain before the wire", async () => {
    await expect(callTool({}, "get_report", {})).rejects.toThrow("'domain' is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a tool it has no route for", async () => {
    await expect(callTool({}, "not_a_tool", {})).rejects.toThrow("unknown tool 'not_a_tool'");
  });
});

describe("query kind", () => {
  it("sends only the arguments it was given, inventing no defaults", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { alerts: [] }));
    await callTool({}, "get_alerts", { domain: "example.com", limit: 5, type: undefined });
    const [url] = lastCall();
    // The server owns every default (window, page size); a default guessed here
    // would quietly disagree with the dashboard's own answer.
    expect(url).toBe(`${DEFAULT_API_BASE}/api/v1/alerts?domain=example.com&limit=5`);
  });

  it("sends a bare GET when no arguments are supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await callTool({}, "get_readiness", {});
    expect(lastCall()[0]).toBe(`${DEFAULT_API_BASE}/api/v1/readiness`);
  });
});

describe("upload kind", () => {
  it("uploads the decoded report bytes as a file part", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { sources: [] }));
    const xml = "<feedback><report_metadata/></feedback>";
    await callTool({}, "parse_dmarc_report", {
      content_base64: Buffer.from(xml).toString("base64"),
      filename: "acme.xml",
    });
    const [url, init] = lastCall();
    expect(url).toBe(`${DEFAULT_API_BASE}/api/tools/dmarc-report-parse`);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get("file") as File;
    expect(part.name).toBe("acme.xml");
    await expect(part.text()).resolves.toBe(xml);
  });

  it("falls back to a default filename — the API only reads bytes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await callTool({}, "parse_dmarc_report", { content_base64: "eA==" });
    const part = (lastCall()[1].body as FormData).get("file") as File;
    expect(part.name).toBe("report.xml");
  });
});

describe("errors throw, carrying the API's own words", () => {
  it("throws a 422 detail verbatim", async () => {
    const detail = "domain must be a valid hostname (got 'x')";
    fetchMock.mockResolvedValue(jsonResponse(422, { detail }));
    await expect(callTool({}, "scan_domain", { domain: "x" })).rejects.toThrow(detail);
  });

  it("relays the 401 token guidance on a monitoring read, unchanged", async () => {
    // Guidance, never a credential prompt: the agent is told where a human mints
    // a token, and that string is the API's to word.
    const detail =
      "this tool needs a DNS Doctor API token — create one at https://dnsdoctor.dev/dashboard/settings and set DNSDOCTOR_API_TOKEN";
    fetchMock.mockResolvedValue(jsonResponse(401, { detail }));
    const error = await callTool({}, "get_alerts", {}).catch((e: Error) => e);
    expect((error as Error).message).toBe(detail);
  });

  it("never puts the token in the thrown message", async () => {
    process.env.DNSDOCTOR_API_TOKEN = "dnsd_YOUR_TOKEN_env";
    fetchMock.mockResolvedValue(jsonResponse(403, { detail: "forbidden" }));
    const error = await callTool({ apiToken: "dnsd_YOUR_TOKEN_cfg" }, "get_readiness", {}).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toBe("forbidden");
    expect((error as Error).message).not.toContain("dnsd_");
  });
});

describe("settings resolution", () => {
  it("prefers plugin config over the environment", async () => {
    process.env.DNSDOCTOR_API_TOKEN = "dnsd_YOUR_TOKEN_env";
    process.env.DNSDOCTOR_API_BASE = "http://env.invalid";
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await callTool(
      { apiToken: "dnsd_YOUR_TOKEN_cfg", apiBase: "http://127.0.0.1:8000/" },
      "get_alerts",
      {},
    );
    const [url, init] = lastCall();
    expect(url).toBe("http://127.0.0.1:8000/api/v1/alerts");
    expect(headersOf(init).Authorization).toBe("Bearer dnsd_YOUR_TOKEN_cfg");
  });

  it("falls back to the environment when the gateway passes no config", async () => {
    process.env.DNSDOCTOR_API_TOKEN = "dnsd_YOUR_TOKEN_env";
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await callTool({}, "get_readiness", {});
    expect(headersOf(lastCall()[1]).Authorization).toBe("Bearer dnsd_YOUR_TOKEN_env");
  });

  it("stays anonymous when neither is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await callTool({}, "scan_domain", { domain: "example.com" });
    expect(headersOf(lastCall()[1]).Authorization).toBeUndefined();
  });
});

describe("reading config out of a gateway snapshot", () => {
  it("finds this plugin's entry", () => {
    const config = {
      plugins: {
        entries: {
          "dns-doctor": { config: { apiToken: "dnsd_YOUR_TOKEN", apiBase: "http://x.invalid" } },
        },
      },
    };
    expect(settingsFromConfig(config)).toEqual({
      apiToken: "dnsd_YOUR_TOKEN",
      apiBase: "http://x.invalid",
    });
  });

  it("degrades to the env fallback on any shape it does not recognize", () => {
    // The per-plugin entry map has moved between gateway versions; throwing here
    // would take all 16 tools down over a key that has an env twin anyway.
    for (const config of [undefined, null, {}, { plugins: {} }, "nonsense", { plugins: 3 }]) {
      expect(settingsFromConfig(config)).toEqual({});
    }
    expect(
      settingsFromConfig({ plugins: { entries: { "dns-doctor": { config: { apiToken: 42 } } } } }),
    ).toEqual({ apiToken: undefined, apiBase: undefined });
  });
});

describe("channel attribution", () => {
  it("stamps every request kind with this plugin's user agent", async () => {
    // The nginx JSON log is the only place ClawHub-sourced traffic becomes
    // visible; without this marker the bet behind the plugin cannot be judged.
    // A fresh Response per call: a body may only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
    for (const call of [
      () => callTool({}, "scan_domain", { domain: "example.com" }),
      () => callTool({}, "get_report", { domain: "example.com" }),
      () => callTool({}, "get_alerts", {}),
      () => callTool({}, "parse_dmarc_report", { content_base64: "eA==" }),
    ]) {
      await call();
      expect(headersOf(lastCall()[1])["User-Agent"]).toMatch(/^dnsdoctor-openclaw-plugin\/\d/);
    }
  });
});

describe("tool construction", () => {
  const tools = buildTools(() => ({}));

  it("builds one AgentTool per pinned definition", () => {
    expect(tools.map((tool) => tool.name)).toEqual(toolNames());
  });

  it("derives every label mechanically from the name", () => {
    for (const name of toolNames()) {
      const label = toolLabel(name);
      expect(label).not.toContain("_");
      expect(label.toLowerCase()).toBe(name.replace(/_/g, " "));
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
    expect(toolLabel("scan_domain")).toBe("Scan domain");
  });

  it("returns the body verbatim in details and pretty JSON in content", async () => {
    const body = {
      domain: "example.com",
      record: "v=DMARC1; p=quarantine; np=reject",
      nested: { keep: [1, 2, 3] },
    };
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const scan = tools.find((tool) => tool.name === "scan_domain");
    expect(scan).toBeDefined();
    const result = await scan!.execute("call-1", { domain: "example.com" });
    expect(result.details).toEqual(body);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(body, null, 2) }]);
  });

  it("throws out of execute rather than encoding the error in content", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { detail: "no persisted report" }));
    const report = tools.find((tool) => tool.name === "get_report");
    await expect(report!.execute("call-2", { domain: "example.com" })).rejects.toThrow(
      "no persisted report",
    );
  });

  it("reads settings at call time, so a config edit needs no reload", async () => {
    let token: string | undefined;
    const live = buildTools(() => ({ apiToken: token }));
    const alerts = live.find((tool) => tool.name === "get_alerts");
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
    await alerts!.execute("call-3", {});
    expect(headersOf(lastCall()[1]).Authorization).toBeUndefined();
    token = "dnsd_YOUR_TOKEN_late";
    await alerts!.execute("call-4", {});
    expect(headersOf(lastCall()[1]).Authorization).toBe("Bearer dnsd_YOUR_TOKEN_late");
  });
});

/**
 * The seam the gateway actually touches. `buildTools`, `settingsFromConfig` and
 * `callTool` are each covered above, but only `toolFactory` composes them — and
 * it holds the one branch that differs by gateway version.
 */
describe("the gateway seam", () => {
  const config = {
    plugins: { entries: { "dns-doctor": { config: { apiToken: "dnsd_YOUR_TOKEN_ctx" } } } },
  };

  async function authorizationVia(ctx: OpenClawPluginToolContext): Promise<string | undefined> {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const alerts = toolFactory(ctx).find((tool) => tool.name === "get_alerts");
    expect(alerts).toBeDefined();
    await alerts!.execute("call-ctx", {});
    return headersOf(lastCall()[1]).Authorization;
  }

  it("builds every tool from the context it is handed", () => {
    expect(toolFactory({ config } as OpenClawPluginToolContext).map((tool) => tool.name)).toEqual(
      toolNames(),
    );
  });

  it("prefers the live getRuntimeConfig snapshot", async () => {
    expect(await authorizationVia({ getRuntimeConfig: () => config } as never)).toBe(
      "Bearer dnsd_YOUR_TOKEN_ctx",
    );
  });

  it("falls back to the runtimeConfig snapshot when only that is populated", async () => {
    // All three sources are optional on `OpenClawPluginToolContext`. Skipping
    // this middle one drops a configured token on a gateway that populates it,
    // and the monitoring reads then 401 with guidance to set a token that IS set.
    expect(await authorizationVia({ runtimeConfig: config } as never)).toBe(
      "Bearer dnsd_YOUR_TOKEN_ctx",
    );
  });

  it("falls back to ctx.config on a gateway without either runtime source", async () => {
    expect(await authorizationVia({ config } as OpenClawPluginToolContext)).toBe(
      "Bearer dnsd_YOUR_TOKEN_ctx",
    );
  });

  it("prefers getRuntimeConfig over the runtimeConfig snapshot", async () => {
    const stale = {
      plugins: { entries: { "dns-doctor": { config: { apiToken: "dnsd_YOUR_TOKEN_stale" } } } },
    };
    expect(
      await authorizationVia({ getRuntimeConfig: () => config, runtimeConfig: stale } as never),
    ).toBe("Bearer dnsd_YOUR_TOKEN_ctx");
  });

  it("falls through a populated source that carries no dns-doctor entry", async () => {
    // The fallback is on the RESOLVED settings, not on the source being
    // present: the per-plugin entry map has moved between gateway versions, so
    // a freshest snapshot shaped differently resolves to `{}` and the token
    // must still be found in a later source.
    const foreign = { plugins: { entries: { "some-other-plugin": { config: {} } } } };
    expect(await authorizationVia({ getRuntimeConfig: () => foreign, config } as never)).toBe(
      "Bearer dnsd_YOUR_TOKEN_ctx",
    );
    expect(await authorizationVia({ runtimeConfig: foreign, config } as never)).toBe(
      "Bearer dnsd_YOUR_TOKEN_ctx",
    );
  });

  it("re-reads the config on every call, not once at registration", async () => {
    let live: unknown = {};
    // A fresh Response per call: a body can only be consumed once.
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
    const alerts = toolFactory({ getRuntimeConfig: () => live } as never).find(
      (tool) => tool.name === "get_alerts",
    );
    await alerts!.execute("call-a", {});
    expect(headersOf(lastCall()[1]).Authorization).toBeUndefined();
    live = config;
    await alerts!.execute("call-b", {});
    expect(headersOf(lastCall()[1]).Authorization).toBe("Bearer dnsd_YOUR_TOKEN_ctx");
  });

  it("threads the gateway's abort signal down to fetch", async () => {
    // This process is a long-lived multi-plugin gateway, so a request nobody
    // awaits any more keeps running to undici's multi-minute default and keeps
    // spending the caller's per-IP scan budget. Discarding the signal the SDK
    // hands `execute` is what would let that happen.
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const controller = new AbortController();
    const scan = toolFactory({ config } as OpenClawPluginToolContext).find(
      (tool) => tool.name === "scan_domain",
    );
    await scan!.execute("call-signal", { domain: "example.com" }, controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
  });

  it("rethrows a cancellation instead of calling it a transient transport fault", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException("This operation was aborted", "AbortError"));
    const scan = toolFactory({ config } as OpenClawPluginToolContext).find(
      (tool) => tool.name === "scan_domain",
    );
    // Not `ApiError(transient)` — telling the agent to "retry" the call the user
    // just interrupted is the opposite of what the cancellation asked for.
    await expect(
      scan!.execute("call-abort", { domain: "example.com" }, controller.signal),
    ).rejects.toThrow("aborted");
  });

  it("rethrows a cancellation that lands during the body read", async () => {
    // An abort after the headers arrive never rejects `fetch` — it surfaces as
    // an unreadable body, which would otherwise be reported as transient with
    // an explicit "retry" instruction for the call the user just interrupted.
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      },
    }));
    const scan = toolFactory({ config } as OpenClawPluginToolContext).find(
      (tool) => tool.name === "scan_domain",
    );
    const error = await scan!
      .execute("call-abort-body", { domain: "example.com" }, controller.signal)
      .then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/abort/i);
    expect(error!.message).not.toMatch(/unreadable response/);
  });

  it("registers the factory itself, so the gateway can rebuild per context", () => {
    const registerTool = vi.fn();
    register({ registerTool } as unknown as OpenClawPluginApi);
    expect(registerTool).toHaveBeenCalledWith(toolFactory);
  });

  it("takes its identity from the manifest, never a literal in src/", () => {
    expect(entry.id).toBe(MANIFEST.id);
    expect(entry.name).toBe(MANIFEST.name);
    expect(entry.description).toBe(MANIFEST.description);
  });
});
