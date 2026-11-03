---
description: "Connects each authenticated member's authorized MCP servers to that member's Agent scope."
kind: "package-reference"
---

# @deepseek-ai/dsh-company-user-mcp

English | [中文](README.zh.md)

## Summary

This Host service queries the configured catalog MCP with the logged-in member's verified principal, exchanges one short-lived platform token per authorized MCP, and registers the discovered tools only in that member's Agent scope. API keys, HMAC secrets, token responses, and upstream URLs stay on the Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The test Web overlay mounts this package through `packages/company/wecom-auth/cordis.patch.yml`. Set `DSH_USER_MCP_ENABLED=1`, `DSH_MCP_LIST_API_KEY`, and `DSH_MCP_PLATFORM_SECRET` in the server environment. The remaining `DSH_MCP_*` variables select the catalog URL, exchange URL, platform id, environment, and secret variable names. Secrets are never accepted in YAML or browser code.

The Remote `companyUserMcp.catalog()` method returns only the authenticated user's MCP ids, names, descriptions, environments, and access labels; a Remote caller needs the `companyUserMcp/catalog` grant, which the WeCom global role carries. The method rejects a caller without a member `userId` with `company-user-mcp/unauthenticated` and reports an unreachable or invalid catalog as `company-user-mcp/catalog-failed`.

An Agent's member is the principal on the newest pending user message, otherwise the latest principal recorded by a Session `user/message`, read through the host-only `companyUserMcpPrincipal` Session projection; a later message without a principal keeps that member. Reconciliation starts when the Agent is created, when a message with a principal enters its inbox, and before each step. One reconciliation per Agent runs at a time; it reuses a loaded catalog for `catalogTtlMs` (default 60 seconds), closes withdrawn servers, connects newly authorized servers in parallel, and replaces every connection when the member changes. Each connection uses its own exchanged token, which is reused until one minute before expiry.

`requestTimeoutMs` bounds one catalog call or token exchange, `connectionTimeoutMs` bounds MCP initialization, and `toolCallTimeoutMs` bounds one tool call. A missing credential, failed catalog, refused exchange, or unreachable server is logged as a warning and never fails the turn: the Agent keeps its current tools, and the next refresh retries the skipped servers. A cancelled step stops waiting while the shared reconciliation continues. Disposing the Agent or the service closes the MCP clients and unregisters their tools.

The same switch registers this package as the company MCP provider. With `DSH_USER_MCP_ENABLED=1`, `company-user-mcp-provider` provides `ctx.companyMcpProvider` from the logged-in member's authorized servers, and the Market HTTP adapter (`company-mcp-provider/http`) is disabled because only one provider may register. The company MCP page therefore lists the same servers the Agent bridge uses. The member is the WeCom login `sub`; portal logins have no WeCom member and fail with `company-mcp/member-unresolved`. Tool schemas load on discovery. A tool call through this provider runs on the member's user MCP in a short-lived session, using the same token exchange as the Agent bridge; a failed call rejects with `company-mcp/call-failed`. Cloud Agent Sessions never receive bridge tools, so their tools come only from the provider and their release policy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The catalog client calls `queryUserAvailableMcp` with `thirdUid`, `accessType: "all"`, page 1, and `maxServers` as the page size, then validates the result's `structuredContent`. The token exchange signs `platformId`, a second-resolution timestamp, a random nonce, and the SHA-256 digest of the exact JSON body with HMAC-SHA256, and sends the result as `X-Platform-Signature: v1=<hex>`. The MCP endpoint is the returned `resource` with `/mcp` appended unless it already ends there. Tool names use the sanitized server name plus an eight-character SHA-256 suffix so two servers whose names sanitize alike cannot collide. Source: [`src/index.ts`](src/index.ts), configuration: [`src/config.ts`](src/config.ts).

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Authorized MCP tools

#### What the model sees

The model sees normal MCP tool schemas under `mcp__<server>__<tool>` names. It never sees the member id, bearer token, HMAC secret, token exchange headers, or upstream endpoint.

#### Token effect

Only discovered tool schemas and tool results enter model requests. Catalog and token-exchange metadata are Host-only.

#### KV Cache effect

Changing the member's authorized MCP catalog changes the tool set for the next request series; credentials are never part of the cached prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A step's tool set is resolved before `agent/pre-step`, so tools first connected during that step appear from the next step; on a fresh Session the first model request of the first turn may lack them.
- The catalog request asks for one page of `maxServers` entries; servers beyond that page are ignored.
- A connection lost during a step fails that tool call; the bridge does not reconnect a listed server until it is withdrawn and authorized again or the member changes.
- The platform decides authorization: an exchange refused for a listed server, or a server that rejects its token, is only skipped with a warning.
- The catalog validator accepts only `structuredContent` carrying `success` and `data.records`; a new wire format must update it.
- Each provider tool call opens a new MCP session; there is no connection reuse, so calls pay one token exchange (cached) and one handshake.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Design rationale: [authenticated user MCP bridge](../../../.agents/notes/implemented/feature/2026-11-02-authenticated-user-mcp-bridge.md).

</details>
