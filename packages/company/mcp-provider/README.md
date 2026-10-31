---
description: "Member-authorized MCP Market provider, HTTP adapter and browser-safe catalog Remote."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-mcp-provider

English | [中文](README.zh.md)

## Summary

The provider reads the MCP Market through authenticated server-to-server endpoints. It derives the WeCom `sub` from the verified Remote caller or the initiating Session and never accepts a browser or model supplied subject. The Market returns only published MCPs for which that member has visibility and usage authorization.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

`baseUrl`, `corpId`, `tokenRef`, request limits, and timeouts are deployment configuration. Member enablement preferences are persisted under a key containing the verified owner scope. The service expects `POST /api/internal/mcp/authorized/page`, `detail`, and `invoke`; each response must have `success: true` and `code: "200"`. It never consumes public endpoint configuration or upstream credentials.

Each tool invocation rechecks the member grant, publication, and schema fingerprint before forwarding `path`, raw tool name, arguments, and the fingerprint to the Market. A catalog failure clears the member catalog, so stale MCPs cannot remain executable.

## Model Experience

### Authorized MCP tools

#### What the model sees

The model sees authorized MCP tool names such as `mcp__company_<hash>__<tool>`, descriptions, input schemas, and text results. It never sees Market URLs, service credentials, WeCom identity fields, or integration configuration.

#### Token effect

The tool schemas and descriptions add tokens for the authorized member's current catalog. Catalog and invocation results enter the normal Session history and vary with Market permissions.

#### KV Cache effect

An unchanged authorized catalog keeps the MCP schema prefix stable. Permission changes, schema fingerprints, or tool publication changes replace the visible schema and can invalidate prefix reuse.

## Known Limitations and Deferred Work

- The Market internal endpoints and service credential are deployment owned; local tests use a fixture and a deployed Market is required for integration testing.
- The Market backend must provide the internal authenticated routes; this repository contains the DSH adapter and contract fixture only.

### Dev Note

The provider must receive identity from `companyWecomAuth`; callers must never add a subject argument to the browser Remote.
