---
description: "Company MCP provider seam with an HTTP gateway adapter and a browser-safe catalog Remote."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-mcp-provider

English | [中文](README.zh.md)

## Summary

This package defines `ctx.companyMcpProvider`, the only Host path that lists, enables and executes company MCP tools. The HTTP adapter reads an external gateway catalog and forwards tool calls to the gateway. `ctx.companyMcp` exposes the catalog to the browser without gateway URLs, headers or upstream error bodies. Cloud Agent consumes the provider; it never talks to the gateway directly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Apply `cordis.patch.yml` to a Web profile and set `DSH_COMPANY_MCP_CATALOG_URL`, `DSH_COMPANY_MCP_INVOKE_URL` in the server environment. When the gateway needs a bearer token, store it under the credential reference `DSH_COMPANY_MCP_TOKEN` (`tokenRef`); it is resolved through `ctx.credentials` for every request, and an unset credential sends no `Authorization` header. Missing or non-HTTP(S) URLs reject activation. The patch mounts `@deepseek-ai/dsh-company-mcp-provider/http` as the provider and the package root as the `companyMcp` Remote.

`GET catalogUrl` returns `{ "servers": [...] }`. Each server has `id` (letters, digits, `_ . : -`, at most 200 characters), `name`, optional `description`, `status` (`available`, `connecting`, `failed` or `maintenance`), optional ISO `updated_at`, and `tools`. Each tool has `name`, optional `description` and an object JSON Schema `input_schema`. Duplicate server ids, duplicate model-facing names and unsupported schemas reject the whole response.

`POST invokeUrl` receives `{ "server_id", "tool", "arguments" }`, where `tool` is the gateway's raw tool name. A success returns `{ "status": "ok", "is_error"?: boolean, "content": [{ "type": "text", "text": "..." }] }`; a refusal returns `{ "status": "error", "error": { "code", "message" } }`. Any other response, timeout, cancellation, non-2xx status or oversized body fails the call.

| Value | Host plugin | Browser | Model | Logs and Session |
| --- | --- | --- | --- | --- |
| `catalogUrl`, `invokeUrl` | yes | no | no | no |
| `tokenRef` value | yes | no | no | no |
| Upstream error body | no | no | no | no |
| Server id, name, description, status | yes | yes | name and description of selected tools | tool names in tool results |
| Tool schema and fingerprint | yes | yes | selected tools only | fingerprints in Cloud Agent releases |

`configure({ id, enabled })` stores only the enabled state. A failed refresh keeps the last good catalog and reports `failure`; a provider that never loaded reports `loaded: false` instead of an empty catalog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CompanyMcpProvider` is the Service Definition; `HttpCompanyMcpProvider` is the Service Provider; `CompanyMcpRemote` and Cloud Agent are consumers. Model-facing names are `mcp__company_<hash>__<tool>`, shortened with a hash to 64 characters. A fingerprint is the SHA-256 of the tool name, description and parameters; Cloud Agent pins it when publishing, and execution re-checks it against the current catalog and fails with `company-mcp/tool-changed` on a mismatch.

Requests use `redirect: 'error'`, the resolved bearer token, a per-request timeout, the caller's signal and the plugin lifetime. Responses are read up to the configured byte limit and decoded as strict UTF-8 JSON. Reported failures carry fixed messages such as `HTTP 503` or `timed out or was cancelled` and never include URLs or bodies. Disposal cancels pending requests, waits for in-flight calls and closes the preference store.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Company MCP tools

#### What the model sees

The provider registers no tools by itself. Cloud Agent registers the tools a release selected; each appears as `mcp__company_<hash>__<tool>` with its gateway description and parameters, and its text result is returned unchanged.

#### Token effect

Each selected tool adds its name, description and parameter schema to the tool list. Results add their text.

#### KV Cache effect

The tool list is fixed by the release, so it stays stable within a Session unless a release changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only text content blocks are accepted from the gateway.
- The catalog refreshes on demand; there is no periodic polling.
- Enablement is deployment-wide, not per member.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
