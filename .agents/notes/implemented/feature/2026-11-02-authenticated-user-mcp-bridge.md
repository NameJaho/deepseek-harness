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

## Company MCP provider

The same bundle also implements `ctx.companyMcpProvider` when enabled, so the company MCP page and Cloud Agent capability selection read the member's authorized servers from the same catalog the Agent bridge uses. The Market HTTP adapter is disabled in that mode because the provider seam accepts one implementation. The provider keys the catalog on the verified WeCom login `sub`; portal logins have no WeCom member id and fail with `company-mcp/member-unresolved` rather than guessing a mapping.

The provider executes resolved tools on the member's user MCP through the same token exchange as the bridge, in a short-lived session per call; failures reject with `company-mcp/call-failed`. Sharing the Agent connection pool was rejected for now: a per-call session keeps the provider stateless across members and releases.

Cloud Agent Sessions do not receive bridge tools. Their release policy enables an explicit tool set, and bridge tools outside that set were refused with `Only tools explicitly enabled for this Cloud Agent can be used`, while still confusing the model with a second name for the same server. The bridge detects a Cloud Agent Session from its `cloud-agent/binding` event through a host-only projection; the event name is typed as a string because depending on the Cloud Agent package would cycle through wecom-auth. The MCP SDK's top-level `$schema` marker is dropped before schema validation because the supported JSON Schema subset rejects it and it does not change validation.

## Member selection of the default Agent's MCPs

The bridge no longer attaches every authorized server. Each member chooses the servers their default Agent may use; the choice is a Host-owned JSON file keyed by platform user id, and a member without a record gets no user MCP tools. A default-empty policy was chosen over attach-all so that a new member never inherits tools they did not select, and so that tool sets track an explicit choice rather than catalog membership.

Selection changes reset each affected Agent's reconciliation time, so they apply from the next step. Tools are removed during the pre-step hook, so the step that observes the change still lists them; this matches the existing additive delay documented above. The Remote rejects ids outside the caller's current catalog, so a stored selection never grants a server the platform has withdrawn: withdrawal still removes the tool by the catalog check, while the stored id stays inert.

The default Agent may also change the selection in conversation through the `user_mcp` tool. Its arguments are validated at the tool boundary and every name is resolved against the member's current catalog, so the model can only choose from servers the member may already use; the tool is absent from Cloud Agent Sessions. The right sidebar's personal-capabilities tab edits the same selection through the Remote; its client is a separate bundle that declares only the shell services it uses. Company knowledge sources are not part of this decision. Knowledge search for a default Agent needs a verified source binding and a fingerprint check, and the company knowledge package depends on wecom-auth, which depends on this package; that cycle must be resolved before knowledge can be bound here.
