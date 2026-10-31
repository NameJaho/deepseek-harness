---
description: "Company member identity, authorized MCP discovery and release-scoped Cloud Agent services."
---

# Company deployment integrations

English | [中文](company.zh.md)

## Summary

Company deployments can require member login, select permitted MCP metadata, and publish reusable Agent releases. This reference owns the company service index; [the package group](../../packages/company/README.md) links each configuration owner.

## Table of Contents

- [Identity and authorization](#identity-and-authorization)
- [Service ownership](#service-ownership)
- [Cordis API reference](#cordis-api-reference)
- [Dev Note](#dev-note)

<a id="identity-and-authorization"></a>
## Identity and authorization

The authentication provider resolves member ownership from a verified request or retained Session. Official WeCom and trusted gateway identities keep separate owner scopes. The Market adapter resolves their exact HR-to-portal mapping and reads the existing list and usage-permission APIs. See [the member directory](../company/mcp-market.md) for current requests, failure handling and deferred invocation.

<a id="service-ownership"></a>
## Service ownership

| Service | Documentation owner |
|---|---|
| `companyWecomAuth` | [Member login and resource grants](../../packages/company/wecom-auth/README.md) |
| `companyMcpProvider`, `companyMcp` | [Member directory and tool discovery](../../packages/company/mcp-provider/README.md) |
| `cloudAgents` | [Drafts, releases and private conversations](../../packages/company/cloud-agent/README.md) |

<a id="cordis-api-reference"></a>
## Cordis API reference

Generated service methods live with their owning subsystems. This index links those references without copying their signatures.

- [MCP directory and tool discovery](mcp.md)
- [Company login, identity and ownership](credentials.md)
- [Cloud Agent service](core.md)

<a id="dev-note"></a>
## Dev Note

None.
