/**
 * The ONE HTTP layer of the plugin — ported from `@dnsdoctor/mcp`'s `api.ts`.
 *
 * Every tool handler goes through here, and nothing else in `src/` may hold a
 * base URL or invent an error message. Three rules are load-bearing:
 *
 * 1. **Relay, never compose.** Response bodies are returned untouched — the
 *    records and signup URLs in them are authored server-side by the fixengine
 *    and are the product's trust moat. This file never edits a payload.
 * 2. **A transport failure is never a verdict.** 429/5xx/network faults map to
 *    explicitly transient errors that tell the agent to retry rather than
 *    report a diagnosis, mirroring the backend's `temperror` discipline.
 * 3. **Failures throw.** `AgentTool.execute` is documented "throw on failure
 *    instead of encoding errors in `content`", so every non-2xx leaves here as
 *    an `Error` whose message is the API's own text. The token is never part of
 *    that message, and never logged.
 *
 * A 422 relays the API's `detail` **verbatim** — those strings are a wire
 * contract shared with the hosted MCP server; rewording them here would let the
 * two surfaces disagree about the same malformed input. The 401 the two
 * monitoring reads answer without a token is the same case: its `detail` is the
 * guidance (mint a token on the dashboard), relayed unchanged. Never prompt a
 * human for a credential from here.
 */

import { readFileSync } from "node:fs";

export const DEFAULT_API_BASE = "https://dnsdoctor.dev";

/** Shared tail of every transient message — one string, so all of them agree. */
export const TRANSIENT_SUFFIX = "retry; never report this as a verdict";

export const RATE_LIMITED_MESSAGE = "rate limited — slow down and retry";

/**
 * A 402 is the same exhausted per-CALLER budget as a 429, offered as a paid
 * burst lane (D104) this client deliberately does not pay: it holds no wallet
 * and never will. So it reads as the rate limit it is — transient, retry — and
 * the offer is named rather than surfaced as an opaque HTTP code.
 */
export const PAYMENT_REQUIRED_MESSAGE =
  "rate limited — a paid burst lane was offered; this client does not pay, so slow down and retry";

/**
 * The plugin's own config block (`configSchema` in `openclaw.plugin.json`).
 *
 * Both fields are optional and both have an environment fallback, because the
 * gateway's per-plugin config path is version-sensitive: an env var works on
 * every gateway version regardless of where the entry map moves.
 */
export interface PluginSettings {
  apiToken?: string | undefined;
  apiBase?: string | undefined;
}

/** Error raised for any non-2xx response or transport fault. */
export class ApiError extends Error {
  readonly status: number | null;
  readonly transient: boolean;

  constructor(message: string, status: number | null, transient: boolean) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.transient = transient;
  }
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** Base URL for the API: plugin config → `DNSDOCTOR_API_BASE` → the public origin. */
export function resolveApiBase(settings: PluginSettings = {}): string {
  const base =
    trimmed(settings.apiBase) ?? trimmed(process.env.DNSDOCTOR_API_BASE) ?? DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

/**
 * The bearer token, when one is configured — sent on every request, GET included.
 *
 * Most tools work anonymously and a token only raises the budget, but the two
 * monitoring reads (`get_alerts`, `get_readiness`) REQUIRE one: without it the
 * API answers 401 and its `detail` is the guidance, which `toApiError` relays.
 */
export function resolveApiToken(settings: PluginSettings = {}): string | undefined {
  return trimmed(settings.apiToken) ?? trimmed(process.env.DNSDOCTOR_API_TOKEN);
}

/**
 * This package's version — the number the UA carries.
 *
 * Read once and memoized: unlike the npm client's short-lived stdio process,
 * this runs inside a long-lived multi-plugin gateway, and `userAgent()` is
 * called on every request — a synchronous `readFileSync` per tool call would
 * block that shared event loop for a value that cannot change at runtime.
 */
let cachedVersion: string | undefined;

export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    cachedVersion = typeof version === "string" ? version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

/**
 * The UA every call carries — this plugin's only attribution.
 *
 * The nginx JSON access log is where the ClawHub channel becomes visible at
 * all: without a distinct marker its traffic is indistinguishable from the npm
 * client's, and the demand signal this build bets on cannot be read.
 */
export function userAgent(): string {
  return `dnsdoctor-openclaw-plugin/${packageVersion()} (+https://dnsdoctor.dev)`;
}

/** Pull the API's `detail` out of an error body, preserving its exact text. */
function detailOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail === undefined || detail === null) return null;
  return JSON.stringify(detail);
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const detail = detailOf(await readBody(response));
  const status = response.status;
  if (status === 429) {
    // The constant leads, so the agent always reads the same instruction; the
    // API's own detail (which domain, which budget) rides along verbatim.
    const message = detail ? `${RATE_LIMITED_MESSAGE} (${detail})` : RATE_LIMITED_MESSAGE;
    return new ApiError(message, status, true);
  }
  if (status === 402) {
    // The x402 offer rides in the `PAYMENT-REQUIRED` header and the body carries
    // no `detail`, so there is nothing to relay verbatim here — only the reason.
    return new ApiError(PAYMENT_REQUIRED_MESSAGE, status, true);
  }
  if (status === 503) {
    return new ApiError(
      `DNS Doctor could not complete the lookup (transient) — ${TRANSIENT_SUFFIX}`,
      status,
      true,
    );
  }
  if (status >= 500) {
    return new ApiError(
      `DNS Doctor returned a server error (HTTP ${status}) — ${TRANSIENT_SUFFIX}`,
      status,
      true,
    );
  }
  // 4xx — the API's own `detail` is the answer (401 token guidance, 422
  // malformed input, opaque 404, 413 oversize report). Verbatim, always.
  return new ApiError(detail ?? `DNS Doctor request failed (HTTP ${status})`, status, false);
}

/**
 * The tool's own arguments as a query string — no defaults, no renames.
 *
 * `undefined`/`null` are dropped rather than sent as empty strings: the two
 * monitoring reads treat an absent filter and a blank one differently, and the
 * server owns every default (page size, window). Everything else is stringified
 * verbatim, so an opaque cursor goes back exactly as it came out.
 */
export function queryString(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    params.append(key, typeof value === "string" ? value : String(value));
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

/**
 * Decode base64, rejecting input Node would silently mangle.
 *
 * Not transient: the caller sent bad bytes, so retrying the same call changes
 * nothing — the agent must re-encode instead of reporting a verdict.
 */
export function decodeBase64(value: string): Buffer {
  // Whitespace (MIME line breaks) and the base64url alphabet are both accepted
  // — Node decodes them and so should we; the round-trip below is what rejects
  // input that is not base64 at all.
  const compact = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new ApiError(
      "'content_base64' is not valid base64 — re-encode the report file and try again",
      null,
      false,
    );
  }
  return bytes;
}

/** One configured caller of the public API; holds no diagnosis logic of its own. */
export class DnsDoctorApi {
  private readonly settings: PluginSettings;
  /**
   * The gateway's cancellation token for the tool call this instance serves.
   *
   * One per call, not per plugin: the instance is constructed inside `callTool`
   * and discarded with it, so there is no cross-call sharing to reason about.
   */
  private readonly signal: AbortSignal | undefined;

  constructor(settings: PluginSettings = {}, signal?: AbortSignal) {
    this.settings = settings;
    this.signal = signal;
  }

  private authHeaders(): Record<string, string> {
    const token = resolveApiToken(this.settings);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async send(path: string, init: RequestInit): Promise<unknown> {
    const url = `${resolveApiBase(this.settings)}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        ...(this.signal ? { signal: this.signal } : {}),
        headers: {
          Accept: "application/json",
          "User-Agent": userAgent(),
          ...this.authHeaders(),
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      // A cancellation is not a transport fault: the caller asked us to stop, so
      // rethrowing it unchanged lets the gateway recognize its own abort. Mapping
      // it to a transient `ApiError` would instead tell the agent to retry the
      // very call the user just interrupted.
      if (this.signal?.aborted) throw error;
      const cause = error instanceof Error ? error.message : String(error);
      throw new ApiError(
        `Could not reach the DNS Doctor API (${cause}) — ${TRANSIENT_SUFFIX}`,
        null,
        true,
      );
    }
    // Same rule as the transport catch above, one step later: an abort that
    // lands AFTER the headers arrive surfaces as an unreadable body rather than
    // a rejected `fetch`, and calling that transient would tell the agent to
    // retry the very call the user just cancelled. Checked on both branches,
    // since `toApiError` reads the body too.
    if (!response.ok) {
      const failure = await toApiError(response);
      this.signal?.throwIfAborted();
      throw failure;
    }
    const body = await readBody(response);
    this.signal?.throwIfAborted();
    if (body === null) {
      throw new ApiError(
        `DNS Doctor returned an unreadable response (HTTP ${response.status}) — ${TRANSIENT_SUFFIX}`,
        response.status,
        true,
      );
    }
    return body;
  }

  /** GET a JSON resource. `path` is API-root-relative and already encoded. */
  getJson(path: string): Promise<unknown> {
    return this.send(path, { method: "GET" });
  }

  /** GET with the tool's own arguments as search params. */
  getWithQuery(path: string, args: Record<string, unknown>): Promise<unknown> {
    return this.getJson(`${path}${queryString(args)}`);
  }

  /** POST a JSON body and return the parsed response, untouched. */
  postJson(path: string, body: unknown): Promise<unknown> {
    return this.send(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * POST one file as `multipart/form-data` — the shape
   * `/api/tools/dmarc-report-parse` expects. The tool takes the report as
   * base64, so the bytes are decoded here and uploaded as a file part rather
   * than re-encoded into JSON.
   */
  // `async`, so a decode rejection reaches callers the same way a transport one
  // does — a synchronous throw from a Promise-returning function is a trap.
  async postFile(
    path: string,
    field: string,
    filename: string,
    contentBase64: string,
  ): Promise<unknown> {
    // Validated, not try/caught: `Buffer.from(s, "base64")` never throws — it
    // silently DISCARDS characters outside the alphabet. Uploading those bytes
    // would earn a 422 "not a DMARC report file", telling the agent its report
    // is invalid when the real fault is the encoding it sent us.
    const bytes = decodeBase64(contentBase64);
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: "application/octet-stream" }), filename);
    // No Content-Type header: fetch sets it with the multipart boundary.
    return this.send(path, { method: "POST", body: form });
  }
}
