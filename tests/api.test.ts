/**
 * The HTTP layer's error contract, exercised directly.
 *
 * `tools.test.ts` covers the happy paths an agent sees through a tool; this file
 * covers the ones it must never mistake for a diagnosis. The distinction the
 * tests below defend is the whole point of `ApiError.transient`: a 429/503/5xx
 * or a dead socket means "ask again", while a 4xx means "the API answered, and
 * its words are the answer". Collapsing the two would let a transport blip
 * render as a verdict about someone's mail.
 *
 * `fetch` is mocked throughout; nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  DEFAULT_API_BASE,
  DnsDoctorApi,
  RATE_LIMITED_MESSAGE,
  TRANSIENT_SUFFIX,
  decodeBase64,
  packageVersion,
  queryString,
  resolveApiBase,
  userAgent,
} from "../src/api.js";

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

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("transient failures are marked, never reported as verdicts", () => {
  it("leads a 429 with the constant and carries the API's detail along", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { detail: "scan budget for example.com" }));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/report/example.com"));
    expect(error.transient).toBe(true);
    expect(error.status).toBe(429);
    expect(error.message).toBe(`${RATE_LIMITED_MESSAGE} (scan budget for example.com)`);
  });

  it("falls back to the bare rate-limit message when the body carries no detail", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/alerts"));
    expect(error.message).toBe(RATE_LIMITED_MESSAGE);
  });

  it("treats a 503 as transient — the parked-domain pack fails closed there", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { detail: "resolver unavailable" }));
    const error = await failureOf(new DnsDoctorApi().postJson("/api/tools/parked-domain-records", {}));
    expect(error.transient).toBe(true);
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });

  it("treats any other 5xx as transient", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/readiness"));
    expect(error.transient).toBe(true);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });

  it("turns a dead socket into a transient error, not a silent rejection", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/readiness"));
    expect(error.transient).toBe(true);
    expect(error.status).toBeNull();
    expect(error.message).toContain("ECONNREFUSED");
  });

  it("survives a thrown non-Error from fetch", async () => {
    fetchMock.mockRejectedValue("socket hang up");
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/readiness"));
    expect(error.message).toContain("socket hang up");
  });

  it("treats an unparseable 2xx body as transient rather than an empty answer", async () => {
    // A proxy error page served with a 200 would otherwise become `details: null`
    // — an agent reading that as "no findings" is the failure mode.
    fetchMock.mockResolvedValue(new Response("<html>maintenance</html>", { status: 200 }));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/report/example.com"));
    expect(error.transient).toBe(true);
    expect(error.message).toContain(TRANSIENT_SUFFIX);
  });
});

describe("4xx answers relay the API's own words", () => {
  it("stringifies a structured detail rather than dropping it", async () => {
    // FastAPI's validation errors are a list, not a string; losing them would
    // leave the agent with only a status code to act on.
    const detail = [{ loc: ["body", "domain"], msg: "field required" }];
    fetchMock.mockResolvedValue(jsonResponse(422, { detail }));
    const error = await failureOf(new DnsDoctorApi().postJson("/api/v1/scan", {}));
    expect(error.transient).toBe(false);
    expect(error.message).toBe(JSON.stringify(detail));
  });

  it("falls back to the status when the body has no detail at all", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/report/example.com"));
    expect(error.message).toBe("DNS Doctor request failed (HTTP 404)");
    expect(error.transient).toBe(false);
  });

  it("ignores a null detail the same way as a missing one", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { detail: null }));
    const error = await failureOf(new DnsDoctorApi().getJson("/api/v1/alerts"));
    expect(error.message).toBe("DNS Doctor request failed (HTTP 400)");
  });
});

describe("base64 decoding rejects what Node would silently mangle", () => {
  it("accepts whitespace and the base64url alphabet", () => {
    const bytes = Buffer.from("<feedback/>");
    const mime = `${bytes.toString("base64").slice(0, 4)}\n${bytes.toString("base64").slice(4)}`;
    expect(decodeBase64(mime).toString()).toBe("<feedback/>");
    expect(decodeBase64(bytes.toString("base64url")).toString()).toBe("<feedback/>");
  });

  it("throws a non-transient error on input that is not base64", () => {
    // Not transient: retrying the same bad bytes changes nothing — the agent has
    // to re-encode, and a "try again" would loop it forever.
    const error = (() => {
      try {
        decodeBase64("this is plainly not base64!!");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).transient).toBe(false);
    expect((error as ApiError).message).toContain("not valid base64");
  });

  it("rejects bad bytes before any request leaves", async () => {
    await expect(
      new DnsDoctorApi().postFile("/api/tools/dmarc-report-parse", "file", "r.xml", "not base64!!"),
    ).rejects.toThrow("not valid base64");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolution helpers", () => {
  it("strips trailing slashes off every base-url source", () => {
    expect(resolveApiBase({ apiBase: "http://x.invalid///" })).toBe("http://x.invalid");
    process.env.DNSDOCTOR_API_BASE = "http://env.invalid/";
    expect(resolveApiBase()).toBe("http://env.invalid");
    expect(resolveApiBase({ apiBase: "   " })).toBe("http://env.invalid");
    delete process.env.DNSDOCTOR_API_BASE;
    expect(resolveApiBase({ apiBase: "" })).toBe(DEFAULT_API_BASE);
  });

  it("stringifies non-string query values and drops absent ones", () => {
    expect(queryString({ limit: 5, ack: false, domain: "x", a: undefined, b: null })).toBe(
      "?limit=5&ack=false&domain=x",
    );
    expect(queryString({})).toBe("");
  });

  it("carries a real version in the user agent", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(userAgent()).toBe(`dnsdoctor-openclaw-plugin/${packageVersion()} (+https://dnsdoctor.dev)`);
  });
});
