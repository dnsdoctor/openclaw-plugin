/**
 * How each tool reaches the DNS Doctor REST API.
 *
 * This table is a verbatim port of `@dnsdoctor/mcp`'s (`claude-plugin/src/index.ts`)
 * and must stay identical to it: both clients speak to the same public API, and a
 * path that drifts on one surface would 404 for that surface's users only —
 * `backend/tests/mcp_server/` pins both tables against the real FastAPI app.
 *
 * `json` posts the caller's arguments as the request body **unchanged** — the
 * tool argument names are the REST field names on every one of these endpoints,
 * so there is nothing to translate and therefore nothing to get wrong. `query`
 * is the same property one transport over: a GET whose search params are the
 * tool's own arguments, values relayed verbatim and absent ones simply omitted
 * (a default invented here would disagree with the server's). The two remaining
 * exceptions carry their own kind: `get_report` puts the domain in the path, and
 * `parse_dmarc_report` takes the report as base64 and must upload it as a file
 * part.
 *
 * The keys are NOT hand-synced with the tool list: a vitest check asserts this
 * table's name set equals `tools.json`'s, so a new backend tool fails here.
 */
export type Route =
  | { kind: "json"; path: string }
  | { kind: "query"; path: string }
  | { kind: "report" }
  | { kind: "upload"; path: string; field: string };

export const ROUTES: Record<string, Route> = {
  scan_domain: { kind: "json", path: "/api/v1/scan" },
  get_report: { kind: "report" },
  build_dmarc_upgrade: { kind: "json", path: "/api/v1/dmarc-upgrade" },
  start_monitoring_signup: { kind: "json", path: "/api/v1/signup-url" },
  count_spf_lookups: { kind: "json", path: "/api/tools/spf-count" },
  validate_dmarc_record: { kind: "json", path: "/api/tools/dmarc-validate" },
  generate_dmarc_record: { kind: "json", path: "/api/tools/dmarc-generate" },
  check_dkim_selector: { kind: "json", path: "/api/tools/dkim-check" },
  parse_dmarc_report: {
    kind: "upload",
    path: "/api/tools/dmarc-report-parse",
    field: "file",
  },
  check_record: { kind: "json", path: "/api/tools/check-record" },
  check_reverse_dns: { kind: "json", path: "/api/tools/reverse-dns-check" },
  audit_spf_includes: { kind: "json", path: "/api/tools/spf-audit" },
  build_parked_domain_records: {
    kind: "json",
    path: "/api/tools/parked-domain-records",
  },
  get_alerts: { kind: "query", path: "/api/v1/alerts" },
  get_readiness: { kind: "query", path: "/api/v1/readiness" },
};

/** The report path for a domain — the one route whose argument rides the URL. */
export function reportPath(domain: string): string {
  return `/api/v1/report/${encodeURIComponent(domain)}`;
}

/** Default upload name when the caller supplies none — the API only reads bytes. */
export const DEFAULT_REPORT_FILENAME = "report.xml";
