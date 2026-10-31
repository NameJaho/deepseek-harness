---
description: "Company deployment integrations: WeCom member login, company MCP, company knowledge, Cloud Agent and external agent delegation."
kind: "package-group"
---

# company/ — company deployment integrations

English | [中文](README.zh.md)

## Summary

This group holds integrations for a company deployment of the Web profile. WeCom login identifies members and isolates their Workspaces, the MCP provider is the only path to company MCP tools, the knowledge service is the only path to approved knowledge spaces, Cloud Agent publishes reusable agents built on those tools and sources, and the external agent provider delegates tasks to Dify apps. Each package README owns its configuration and contracts; none is part of a default profile.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`wecom-auth`](wecom-auth/README.md) | WeCom self-built app login and member principals | `companyWecomAuth` |
| [`mcp-provider`](mcp-provider/README.md) | Company MCP provider seam, HTTP gateway adapter and catalog Remote | `companyMcpProvider`, `companyMcp` |
| [`knowledge`](knowledge/README.md) | Approved knowledge sources over HTTP retrieval and the owner test page | `companyKnowledge` |
| [`cloud-agent`](cloud-agent/README.md) | Cloud Agent drafts, immutable releases, directory and use groups | `cloudAgents` |
| [`cloud-agent-runtime`](cloud-agent-runtime/README.md) | Release-pinned prompt and tool policy inside each Cloud Agent Session | — (Agent-scoped plugin) |
| [`external-agent-subagent`](external-agent-subagent/README.md) | External agent subagent providers with a Dify blocking adapter | `externalAgentSubagents` |

<a id="related-documentation"></a>
## Related documentation

- [Capability seams](../../docs/capability-seams.md) — owners, implementations and consumers of these services.
- [Web server](../../docs/subsystems/web-server.md) — the Web profile these integrations extend.

<a id="dev-note"></a>
## Dev Note

None.
