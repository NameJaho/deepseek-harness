---
description: "Existing Market APIs used to display the signed-in member's permitted MCP directory."
---

# MCP Market member directory

English | [中文](mcp-market.zh.md)

## Summary

The company MCP page shows the signed-in user's published, visible MCPs with current usage permission. The adapter uses existing Market APIs. Tool invocation and upstream gateway authentication are deferred.

## Table of Contents

- [Identity resolution](#identity-resolution)
- [Existing read APIs](#existing-read-apis)
- [Directory and tool details](#directory-and-tool-details)
- [Deployment and verification](#deployment-and-verification)
- [Dev Note](#dev-note)

<a id="identity-resolution"></a>
## Identity resolution

The Host obtains a `CompanyMarketSubject` from the verified Remote caller or retained Session owner through `companyWecomAuth.marketSubject()`. Official WeCom subjects carry `corpId/sub`; trusted portal subjects carry their portal user id. The browser cannot supply another member's identity.

The adapter sends official WeCom subjects directly with the verified `sub`; it does not require the member to have Market administrator permission. Trusted portal subjects match the exact numeric `userId` in the paginated HR records through `admin/user/list`, then use the mapped WeCom id. Missing or ambiguous portal mappings produce a structured failure instead of guessing from names or treating a WeCom id as a portal id.

Market list, detail and tool reads carry URL-encoded `X-User-Info` containing the resolved portal `userId/userName`. This is a trusted-backend identity assertion, not a login credential. Permission checks use the resolved WeCom `sub`. Raw HR records, identity headers and connection settings remain on the Host.

<a id="existing-read-apis"></a>
## Existing read APIs

All routes below are existing `POST` endpoints relative to the configured Market root, including its `/mcp-market` context path. Controller success requires HTTP success plus `success: true`, string `code: "200"`, and the expected `data` fields.

| Route | Request fields | Purpose |
|---|---|---|
| `/api/mcp/admin/user/list` | `activeOnly: true`, `pageNum/pageSize` for trusted portal subjects | Resolve an exact portal-to-WeCom mapping; official WeCom subjects do not call this administrator route |
| `/api/mcp/list` | `accessFilter: "all"`, `pageNum/pageSize` | Read published candidates visible to the mapped portal user |
| `/api/internal/mcp/permission/check` | `sub`, `path` | Check the actual member's current usage permission |
| `/api/mcp/query/by/id` | numeric `id` | Recheck one selected server before explicit tool discovery |
| `/api/mcp/tool/list` | numeric `mcpServiceId` | Read tool names, descriptions and string-encoded `inputSchema` |

The list API establishes publication and portal visibility. The permission API does not check publication, so it cannot replace the list. Every returned server must also pass `allowed: true` with matching subject, path and resource identity. The adapter excludes refactoring services and sends no administrator permission declaration. It does not use application, grant or revoke endpoints.

<a id="directory-and-tool-details"></a>
## Directory and tool details

Directory reads return server names, descriptions and the list's tool counts without fetching tool schemas or connection endpoints. Explicit discovery checks the current authorized directory again, then reads detail and tools. Tool schemas must decode from JSON strings to supported object schemas. A malformed tool schema fails discovery without making the directory unreadable.

Identity resolution, pagination and permission checks share a whole-operation timeout and byte budget. Page totals must stay consistent and server ids must be unique. Unsafe numeric ids, incomplete pages, oversized responses, mismatched permission responses and failed envelopes return an empty directory with a failure. There is no shared member catalog cache.

Cloud Agent draft capability metadata can still use discovered tools. Executable definitions reject with `company-mcp/call-unavailable` before any invocation request. The adapter neither calls an invented execution endpoint nor uses a user's directory access as an MCP transport credential.

<a id="deployment-and-verification"></a>
## Deployment and verification

The optional [Market patch](../../packages/company/mcp-provider/cordis.patch.yml) requires the company identity service. Set `DSH_MCP_MARKET_URL` to the existing backend root; official login uses the existing `DSH_WECOM_CORP_ID`. No separate Market service token is required by this adapter. Limits are in [Config](../../packages/company/mcp-provider/src/http.ts).

The current adapter targets a trusted internal backend. Access to the administrative HR read and internal permission check must be restricted by the deployment network. A public portal gateway may require its own login and resource-operation context; this adapter does not fabricate those credentials. Real gateway authentication and MCP execution need separate integration.

Tests cover exact member mapping, two-user isolation, open services, revocation, pagination, read limits, failed envelopes and discovery failures. The real Loader composes the provider and member Remote. The `company-mcp-member` keyless headless snapshot records a permitted directory followed by an empty directory after revocation. Production Market connectivity has not been verified.

<a id="dev-note"></a>
## Dev Note

None.
