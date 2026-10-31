---
description: "Internal Market API required by DSH for member-authorized MCP discovery and invocation."
---

# MCP Market integration

English | [中文](mcp-market.zh.md)

## Summary

DSH queries and invokes MCP tools for the authenticated WeCom member. This reference defines the internal API required from the Market backend. The backend implementation and production integration are deployment prerequisites; this repository supplies the DSH adapter and deterministic fixtures.

## Table of Contents

- [Identity and service authentication](#identity-and-service-authentication)
- [Internal routes](#internal-routes)
- [Invocation checks](#invocation-checks)
- [Deployment and verification](#deployment-and-verification)
- [Dev Note](#dev-note)

<a id="identity-and-service-authentication"></a>
## Identity and service authentication

The Host resolves `corpId` and `sub` from an enabled official WeCom Principal or the retained owner of the initiating Session through `companyWecomAuth.marketSubject()`. `sub` is the official enterprise member UserId. Display names are excluded. A trusted gateway's `userId` has a separate owner scope and is refused until a verified mapping to an official member exists. Browser Remote methods do not accept identity arguments.

Every Market request uses `Authorization: Bearer <service credential>` and JSON. The backend must authenticate the service, constrain it to the configured enterprise, and resolve the member's current visibility and usage authorization. Possessing the service credential alone does not grant a member access to every MCP. Public catalog and creator-only connection settings do not establish usage authorization.

<a id="internal-routes"></a>
## Internal routes

The adapter sends `POST` requests below the configured `baseUrl`. Responses must be HTTP success and contain both `success: true` and string `code: "200"`; all other responses fail. Successful `data` fields are:

| Route | Request fields | Successful `data` |
|---|---|---|
| `/api/internal/mcp/authorized/page` | `corpId`, `sub`, `pageNum`, `pageSize` | `records`, `total`, `pageNum`, `pageSize` |
| `/api/internal/mcp/authorized/detail` | `corpId`, `sub`, `id` | Server fields and `tools[]` |
| `/api/internal/mcp/authorized/invoke` | `corpId`, `sub`, `id`, `path`, `tool`, `arguments`, `schemaFingerprint` | `isError`, `content[{type:"text",text}]` |

A server record contains string `id`, `path`, `name`, `description`, literal `authorized: true`, literal `published: true`, and `status` in `available`, `connecting`, `failed`, or `maintenance`. Each detail tool contains string `name`, string `description`, and an object `inputSchema` whose root `type` is `object`. Responses must exclude MCP endpoints, upstream credentials and `integrationConfig`.

Pagination is one-based, has a configured size of at most 100, and must report a consistent `total` and unique server ids across pages. Detail must return the requested id and the same path as the page record. DSH validates the complete catalog before returning any servers. It rejects partial, duplicate, oversized or unsupported schema data. Provider [Config](../../packages/company/mcp-provider/src/http.ts) owns byte, count and timeout limits.

The backend returns `FORBIDDEN` or `NOT_FOUND` when membership, visibility, publication or usage authorization fails, and `TOOL_CHANGED` when the invocation fingerprint is stale. An HTTP 403 also denies access. Other failures return no catalog. An untrusted or interrupted invocation response produces an unknown-outcome error; users must inspect the operation before retrying. `isError: true` records a tool failure.

<a id="invocation-checks"></a>
## Invocation checks

The Market must recheck the member, selected MCP, publication and current schema for every detail and invocation request. Invocation must authorize the requested id, resolve its current path and raw tool name, and compare the supplied fingerprint before dispatch. These checks must share a consistent authorization/schema view with dispatch so a concurrent grant or tool change cannot be bypassed by an earlier detail response.

DSH fingerprints the model-visible `{name, description, parameters}` with SHA-256 over canonical JSON: object keys sort lexically, arrays preserve order, and no extra whitespace is emitted. `parameters` is the detail tool's `inputSchema`. The public name is derived from the stable server id and raw tool name; the authoritative naming and fingerprint functions are [companyMcpToolName and companyMcpFingerprint](../../packages/company/mcp-provider/src/provider.ts). The backend must use the same representation when checking `schemaFingerprint`.

Enablement preferences are keyed by member owner scope and server id. Catalog requests read current authorization without a shared user cache; failure returns an empty catalog. Cloud Agent save and publication pin tool fingerprints. Start, model steps and execution recheck the current runner's rights. A member running another author's public Agent therefore uses the runner's MCP grants. Publication does not transfer the author's permissions.

<a id="deployment-and-verification"></a>
## Deployment and verification

The optional [Market patch](../../packages/company/mcp-provider/cordis.patch.yml) requires the WeCom authentication service, credential provider and storage-domain service. Deployment supplies `DSH_MCP_MARKET_URL`, `DSH_WECOM_CORP_ID`, and the `DSH_MCP_MARKET_TOKEN` service credential reference. The [Cloud Agent patch](../../packages/company/cloud-agent/cordis.patch.yml) consumes this provider. Neither patch deploys the Market backend.

Repository tests exercise two-member isolation, execution identity, revoked grants, unpublished MCPs, schema changes, failed envelopes and unknown invocation outcomes. A real Loader fixture composes the HTTP provider with its browser Remote. The `company-mcp-member` keyless recorded Session starts the shipped headless profile and records HTTP success followed by revocation. Real Market integration requires the backend routes and deployment credential; it has not been performed with the repository fixture.

<a id="dev-note"></a>
## Dev Note

None.
