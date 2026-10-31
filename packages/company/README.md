---
description: "Company deployment integrations: WeCom member login, company MCP and Cloud Agent."
kind: "package-group"
---

# company/ — company deployment integrations

English | [中文](README.zh.md)

## Summary

This group contains opt-in integrations for a company Web deployment. WeCom login identifies members and isolates their Workspaces, the MCP provider exposes only member-authorized Market tools, and Cloud Agent publishes reusable agents built on those tools. Each package README owns its configuration and contracts.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`wecom-auth`](wecom-auth/README.md) | WeCom self-built app login and member principals | `companyWecomAuth` |
| [`mcp-provider`](mcp-provider/README.md) | Member-authorized MCP Market provider and catalog Remote | `companyMcpProvider`, `companyMcp` |
| [`cloud-agent`](cloud-agent/README.md) | Cloud Agent drafts, immutable releases, directory and use groups | `cloudAgents` |
| [`cloud-agent-runtime`](cloud-agent-runtime/README.md) | Release-pinned prompt and tool policy inside each Cloud Agent Session | — (Agent-scoped plugin) |

<a id="related-documentation"></a>
## Related documentation

- [MCP Market integration](../../docs/company/mcp-market.md) — internal routes, identity propagation and failure handling.
- [Capability seams](../../docs/capability-seams.md) — owners, implementations and consumers of these services.
- [Company services](../../docs/subsystems/company.md) — member identity, catalogs and Agent service index.

<a id="dev-note"></a>
## Dev Note

None.
