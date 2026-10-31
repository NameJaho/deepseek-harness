---
description: "Member-scoped directory and tool discovery through the existing MCP Market APIs."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-mcp-provider

English | [中文](README.zh.md)

## Summary

Signed-in members can view their permitted MCPs and inspect tool definitions. The provider resolves their Market identities, reads published visible candidates and filters them through the existing usage-permission check. It offers no application, grant, revoke or enablement action.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [patch](cordis.patch.yml) uses `DSH_MCP_MARKET_URL` and the existing `DSH_WECOM_CORP_ID`. `baseUrl`, `corpId`, timeouts and read limits belong to deployment configuration. The provider needs the company identity service and no separate service credential. See [existing read APIs and deployment requirements](../../../docs/company/mcp-market.md).

Directories use the Market list's tool counts and do not depend on tool discovery. Explicit discovery reads detail and tool definitions after checking the member's current directory. Refresh failures clear the directory. Tool schemas and fingerprints remain available to Cloud Agent drafts; execution rejects with `company-mcp/call-unavailable` before sending a request.

<a id="model-experience"></a>
## Model Experience

### Member directory and tool definitions

#### What the model sees

The provider registers no global model tool. Authoring consumers may expose permitted server summaries and discovered tool names such as `mcp__company_<hash>__lookup`, descriptions and schemas. Market URLs, HR records, identity headers and integration configuration remain private.

#### Token effect

A browser directory read adds no model tokens. An authoring consumer's catalog or explicit tool discovery can add permitted metadata to the normal Session history.

#### KV Cache effect

Browser refreshes do not alter the model prompt. A consumer that selects discovered tool schemas can change the request prefix when its capability selection changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Identity resolution requires a unique active HR mapping with a positive portal user id and nonempty WeCom id.
- The backend must be reachable through the deployment's trusted internal network; public portal gateway authentication has not been integrated or production-tested.
- Actual MCP transport authentication and tool execution are deferred. Directory or schema access does not imply an executable connection.

<a id="dev-note"></a>
### Dev Note

Browser Remote methods resolve the current login themselves and never accept a member id from browser input.
