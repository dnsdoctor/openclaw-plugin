# DNS Doctor — OpenClaw plugin

A native OpenClaw plugin (published on ClawHub as `@dnsdoctor/openclaw-plugin`)
plus a ClawHub skill, so your agent can scan, fix and verify a domain's DNS — email authentication (SPF, DMARC, DKIM)
first, plus multi-region propagation, SPF include supply-chain audits, MX, DNS
health, blacklists and domain/SSL expiry. Every fix record is generated and validated by a deterministic
engine — RFC grammar plus the SPF 10-lookup counter — **never an LLM guess**.

## What's inside

```
openclaw-plugin/
├── openclaw.plugin.json     # the native plugin's manifest (contracts.tools = the 16 tools)
├── package.json             # builds src/ → dist/index.js with tsc; zero runtime deps
├── src/{index,api,routes}.ts # the plugin: 16 registerTool wrappers over the public REST API
├── tools.json               # the tool definitions, generated from the server — never authored here
├── tests/                   # the invariant tests (definitions only from tools.json; nothing composed)
├── plugin.json              # the older manifest wrapping the hosted MCP endpoint
├── GUIDANCE.md              # the scan → diagnose → fix workflow + the verbatim-record rule
├── skills/dns-doctor/       # the ClawHub skill (REST-first, curl-only)
│   └── SKILL.md
├── LICENSE                  # Apache-2.0
└── README.md
```

The native plugin is a thin client in front of the public REST API at
`https://dnsdoctor.dev` — it composes no record and no URL, and relays every API
field verbatim. `plugin.json` is the older manifest that points an MCP-capable
OpenClaw at the hosted server (`https://dnsdoctor.dev/mcp`); both expose the
same 16 tools.

## Tools

| Tool | Does |
|---|---|
| `scan_domain` | Fresh scan of a domain; full report. |
| `get_report` | Persisted report (scans once if none exists). |
| `build_dmarc_upgrade` | A validated DMARC enforcement record, capped at `p=quarantine` and returned only when the server-derived alignment gate passes; without that evidence the answer is reporting-first and no record is returned. `p=reject` comes from the readiness engine's aggregate-report evidence, never from a scan. |
| `count_spf_lookups` | The SPF DNS-lookup count against the RFC limit of 10. |
| `validate_dmarc_record` | Parse and validate a DMARC record, tag by tag. |
| `generate_dmarc_record` | Build a DMARC record from a policy + reporting address. |
| `check_dkim_selector` | Look up one DKIM selector and check the key. |
| `parse_dmarc_report` | Parse an aggregate (RUA) report file into rows. |
| `check_record` | Read any DNS record type for a name. |
| `check_propagation` | Whether a DNS change has gone global: six vantage points (five owner-run probes plus the server's own resolver) read the same name, returning the grid plus a deterministic verdict. Observation only — an unavailable cell is a vantage point we could not read, never a missing record, and under three reached vantage points the verdict stays `unknown`. |
| `check_reverse_dns` | PTR / forward-confirmed reverse DNS for an IP. |
| `audit_spf_includes` | The SPF include/redirect tree — who can transitively send as the domain, with typed findings (broken include, confirmed-unregistered include, expiring registration, nested `+all`). Analysis only; no SPF fix record. |
| `build_parked_domain_records` | The Null MX + `v=spf1 -all` + `p=reject; np=reject` hardening pack for a domain that sends no mail. The server re-checks DNS itself and refuses when it finds evidence of mail. |
| `start_monitoring_signup` | A sign-up link to hand to the human who owns the domain. Sends no email and creates nothing — they open it, sign in on our page themselves (a social provider or an emailed link, whichever that deployment offers), and the domain is carried over to their dashboard already filled in; monitoring starts once they verify it with a TXT record. |
| `get_alerts` | **Token required.** The account's monitoring alert log, newest first. Read-only — no acknowledge, no delete. Page down with `before` until `next_before` is `null` before advancing `since`. |
| `get_readiness` | **Token required.** Whether one monitored domain's aggregate-report evidence justifies a stronger DMARC policy yet: `ready`, the `blockers`, and `next_record` (validated, or `null` while blocked — which is an answer, not a gap). |

The two monitoring reads are **listed for everyone and callable with a token**:
they appear in the tool list, and without a valid token the call is refused with
the page the account owner mints one on. The `dnsdoctor://domains` resource
(your monitored domains) is likewise always listed and refused without a token.
Anonymous access covers all fourteen diagnosis tools, which is enough for a
one-off diagnosis.

## Install

The native plugin, from ClawHub:

```bash
openclaw plugins install @dnsdoctor/openclaw-plugin
```

Or from this checkout: `npm ci && npm test && npm run build`, then point OpenClaw
at the directory (`openclaw.plugin.json` names `dist/index.js`). Set
`DNSDOCTOR_API_TOKEN` in the plugin's environment to unlock the two token-gated
monitoring reads; everything else works anonymously.

The MCP route instead: enable `plugin.json` and OpenClaw connects to
`https://dnsdoctor.dev/mcp` over streamable HTTP. The agent guidance in
[GUIDANCE.md](./GUIDANCE.md) applies to both.

## Optional: API token for monitored domains

Anonymous access covers scanning and fixes. A per-account API token unlocks the
account's own monitoring data: the `get_alerts` and `get_readiness` tools, and
the `dnsdoctor://domains` resource:

1. Sign in at <https://dnsdoctor.dev> → **Settings → API tokens** → create a token
   (the `dnsd_…` plaintext is shown once).
2. Add an `Authorization` header to the server in `plugin.json`:

   ```json
   "mcp": {
     "servers": {
       "dns-doctor": {
         "transport": "http",
         "url": "https://dnsdoctor.dev/mcp",
         "headers": { "Authorization": "Bearer dnsd_YOUR_TOKEN" }
       }
     }
   }
   ```

   Prefer an environment variable over a committed literal; never commit the token.

## Worked example

> **User:** My newsletter keeps getting spoofed. Domain `example.com`.
>
> **Agent** (`scan_domain`): DMARC is `p=none` — no enforcement, so spoofed mail
> isn't rejected. SPF is aligned (6/10 lookups). DKIM selector found and valid. Not
> blacklisted.
>
> **Agent** (`build_dmarc_upgrade`): Alignment holds, so the recommendation reaches
> its ceiling, `p=quarantine`. Publish this exact TXT record at
> `_dmarc.example.com` — paste it verbatim:
>
> ```
> v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=r; aspf=r; np=reject
> ```
>
> Apply it in DNS once approved, then re-scan to confirm.

## Learn more

- **Methodology:** <https://dnsdoctor.dev/methodology>
- **REST API / OpenAPI schema:** <https://dnsdoctor.dev/api/v1/openapi.json>

## License

[Apache-2.0](./LICENSE). (The `skills/dns-doctor` SKILL.md is additionally
published on ClawHub, which force-licenses skills MIT-0 — accepted for that
file's text only.)
