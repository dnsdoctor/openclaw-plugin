# DNS Doctor — OpenClaw plugin

Wraps the hosted DNS Doctor MCP server as an OpenClaw plugin so your agent can
diagnose and fix a domain's email authentication (SPF, DMARC, DKIM, MX, blacklist,
domain/SSL expiry). Every fix record is generated and validated by a deterministic
engine — RFC grammar plus the SPF 10-lookup counter — **never an LLM guess**.

## What's inside

```
openclaw-plugin/
├── plugin.json              # manifest wrapping the MCP endpoint
├── GUIDANCE.md              # the scan → diagnose → fix workflow + the verbatim-record rule
├── skills/dns-doctor/       # the ClawHub-publishable skill (REST-first, curl-only)
│   └── SKILL.md
├── LICENSE                  # Apache-2.0
└── README.md
```

> **Schema note:** OpenClaw's manifest format evolves. Validate `plugin.json`
> against the current OpenClaw plugin docs before publishing and correct any field
> names if they've changed — the MCP endpoint (`https://dnsdoctor.dev/mcp`, HTTP
> transport) is the part that must survive.

## Tools it adds

| Tool | Does |
|---|---|
| `scan_domain` | Fresh scan of a domain; full report. |
| `get_report` | Persisted report (scans once if none exists). |
| `build_dmarc_upgrade` | A validated DMARC enforcement record — `p=reject` only when the server-derived alignment gate passes. |
| `start_monitoring_signup` | A sign-up link to hand to the human who owns the domain. Sends no email and creates nothing — they open it, sign in on our page themselves (a social provider or an emailed link, whichever that deployment offers), and the domain is carried over to their dashboard already filled in; monitoring starts once they verify it with a TXT record. |

The `dnsdoctor://domains` resource (your monitored domains) is always listed;
reading it needs an API token and is refused without one. Anonymous access is
enough for a one-off diagnosis.

## Install

1. Copy this `openclaw-plugin/` directory into your OpenClaw plugins location (or
   install it from the OpenClaw plugin index once listed).
2. Enable the `dns-doctor` plugin. It connects to `https://dnsdoctor.dev/mcp` over
   streamable HTTP.
3. The agent guidance in [GUIDANCE.md](./GUIDANCE.md) loads with the plugin.

## Optional: API token for monitored domains

Anonymous access covers scanning and fixes. For the `dnsdoctor://domains` resource:

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
> **Agent** (`build_dmarc_upgrade`): Alignment holds, so `p=reject` is safe. Publish
> this exact TXT record at `_dmarc.example.com` — paste it verbatim:
>
> ```
> v=DMARC1; p=reject; rua=mailto:dmarc@example.com; adkim=r; aspf=r
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
