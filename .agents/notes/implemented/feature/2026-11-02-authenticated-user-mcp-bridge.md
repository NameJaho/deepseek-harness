# Agent Note: Authenticated user MCP bridge

Status: implemented

English | [中文](2026-11-02-authenticated-user-mcp-bridge.zh.md)

## Problem

The deployment needs to show each logged-in member the MCP servers they can use and make those servers available to that member's Agent. The existing MCP client accepts a static endpoint and headers, while the platform requires a per-user HMAC token exchange and a separate catalog MCP call.

## Decision

`@deepseek-ai/dsh-company-user-mcp` owns the integration. It reads the authenticated member id from the newest pending user message or, through a host-only Session projection, from the latest principal recorded on the Agent Session, so a resumed or forked Session keeps its member without scanning the event log. It calls the catalog MCP with a Host-only API key, exchanges one short-lived token per `(user, mcp, environment)`, and registers discovered tools through the existing `dsh-mcp-client` bridge in the Agent scope. Tool and connection state is disposed with the Agent. The bundle is disabled by default and reads all secrets from process environment variables.

The catalog service is consumed through normal MCP `initialize`, `tools/list`, and `tools/call` operations. The token exchange signs the exact JSON bytes sent over HTTP with `app_id + timestamp + nonce + sha256(body)`, and cached tokens refresh one minute before expiry. The browser and model receive catalog summaries and tool schemas only; credentials, resource URLs, and exchange headers stay in the Host.

## Alternatives considered

The existing static `mcp-client` configuration was considered, but it cannot select a user identity or perform the platform HMAC exchange. A browser-side token flow was rejected because it would expose the platform secret and would bypass Host-side principal authorization. Copying the catalog into the Agent loop was rejected because MCP registration and cleanup already belong to the tool bridge and Agent scope.

## Consequences

Members see only tools returned for their own principal, and tool registrations disappear when the Agent is disposed. The Remote catalog method reports failures as structured `RemoteError` codes. Inside a turn, catalog, exchange, and connection failures are contained per server and logged, because one unavailable upstream must not fail a member's conversation; the Agent keeps its current tools until the next refresh.

Reconciliation starts at Agent creation and inbox insertion as well as before each step, because the agent loop resolves a step's tool set before `agent/pre-step`. Tools connected during a step still appear only from the next step; removing that delay requires an agent-loop extension point. A per-Agent catalog TTL bounds catalog traffic, and tokens are reused until one minute before expiry.
