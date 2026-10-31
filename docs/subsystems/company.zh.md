---
description: "企业成员身份、按授权发现 MCP 和按发布版本执行 Cloud Agent 的服务。"
---

# 企业部署集成

[English](company.md) | 中文

## 概述

企业部署可以要求成员登录、仅选择有权限的 MCP 工具，并发布可复用 Agent。本参考页负责企业服务索引；[包组说明](../../packages/company/README.zh.md)链接各自的配置与 API 所有者。

## 目录

- [身份与授权](#identity-and-authorization)
- [服务所有权](#service-ownership)
- [Cordis API 参考](#cordis-api-reference)
- [开发备注](#dev-note)

<a id="identity-and-authorization"></a>
## 身份与授权

认证提供方从已验证请求或持久化 Session 解析成员所有权。市场请求需要官方企微身份及部署服务凭据。网关身份有独立的所有者范围，需要经过验证的映射后才能提供市场 subject。请求、响应校验和联调前提见[市场内部 API](../company/mcp-market.zh.md)。

<a id="service-ownership"></a>
## 服务所有权

| 服务 | 文档所有者 |
|---|---|
| `companyWecomAuth` | [成员登录与资源授权](../../packages/company/wecom-auth/README.zh.md) |
| `companyMcpProvider`, `companyMcp` | [按成员授权的目录与执行](../../packages/company/mcp-provider/README.zh.md) |
| `cloudAgents` | [草稿、发布版本和私有对话](../../packages/company/cloud-agent/README.zh.md) |

<a id="cordis-api-reference"></a>
## Cordis API 参考

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcloudagents--cloudagentservice"></a>

### `ctx.cloudAgents` — `CloudAgentService`

Durable directory retaining exact releases and per-member Session ownership.

```ts cordis-catalog
/** Read owned drafts, public-or-owned releases and private usage groups.
 * @returns authoritative credential-free directory and capability choices.
 */
@Remote async catalog(): Promise<CloudAgentCatalog>

/** Follow committed directory and provider changes, coalescing slow readers.
 * @param signal - subscriber cancellation.
 * @returns initial and subsequent authoritative catalogs.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<CloudAgentCatalog>

/** Create a private draft from a live authorized conversation.
 * @param draft - validated reusable fields.
 * @param authoringSessionId - owning live editor; omission rejects creation.
 * @returns committed record; no release is created.
 */
@Remote({ resources: { session: (_draft, authoringSessionId) => authoringSessionId } }) create(draft: CloudAgentDraft, authoringSessionId?: SessionId): Promise<CloudAgentRecord>

/** Save one conversation's reusable requirements with executor-call deduplication.
 * @param agent - live initiating Agent.
 * @param requestId - tool executor call identity.
 * @param draft - complete reusable definition.
 * @param id - existing draft; omission uses this conversation's draft.
 * @param expectedRevision - exact revision for replacing an existing draft.
 * @param createNew - request a separate draft; a bound editor must use another Session.
 * @returns committed record, including on an exact replay.
 */
saveFromConversation(agent: Agent, requestId: string, draft: CloudAgentDraft, id?: CloudAgentId, expectedRevision?: number, createNew: boolean = false): Promise<CloudAgentRecord>

/** Open an owner-private editor with a selectable creation preset.
 * @param request - optional owned draft, source Session, extraction prompt and selectable creation preset;
 * reuse returns a live matching editor.
 * @param signal - creation cancellation.
 * @returns ready Session identity; failed preparation rolls back its resources.
 */
@Remote({ resources: { session: request => request.sourceSessionId } }) startAuthoring(request: { readonly id?: CloudAgentId readonly sourceSessionId?: SessionId readonly prompt?: string readonly reuse?: boolean readonly creationPreset?: string }, signal: AbortSignal): Promise<{ readonly sessionId: SessionId }>

/** Replace a draft without modifying any retained release.
 * @param request - owning editor, exact revision and complete new definition.
 * @returns next revision; stale writes preserve the current record.
 */
@Remote({ resources: { session: request => request.authoringSessionId } }) update(request: CloudAgentUpdateRequest): Promise<CloudAgentRecord>

/** Publish a confirmed revision and audience, deduplicating an exact publication replay.
 * @param request - owning editor, confirmed draft revision and public/private visibility; omission means public.
 * @returns the committed record; stale unrelated revisions fail without creating a release.
 */
@Remote({ resources: { session: request => request.authoringSessionId } }) publish(request: CloudAgentPublishRequest): Promise<CloudAgentRecord>

/** Withdraw publication while preserving existing private Sessions and releases.
 * @param request - owning editor and exact record revision.
 * @returns updated record.
 */
@Remote({ resources: { session: request => request.authoringSessionId } }) unpublish(request: CloudAgentRevisionRequest): Promise<CloudAgentRecord>

/** Start an exact current public-or-owned release with only its pinned capabilities.
 * @param request - exact directory entry and optional selectable run preset and model override.
 * @param signal - creation cancellation.
 * @returns fresh owner-private ordinary Session.
 */
@Remote startSession(request: CloudAgentStartRequest, signal: AbortSignal): Promise<CloudAgentSession>

/** Snapshot and test an owned draft without publishing it.
 * @param request - exact draft revision and live editor.
 * @param signal - creation cancellation.
 * @returns independent private Session pinned to a preview release.
 */
@Remote({ resources: { session: request => request.authoringSessionId } }) preview(request: CloudAgentRevisionRequest, signal: AbortSignal): Promise<CloudAgentSession>

/** Clone an accessible published release into a private editor-owned draft.
 * @param request - current directory release and authorized editor.
 * @returns independent record with no copied conversations.
 */
@Remote({ resources: { session: request => request.authoringSessionId } }) clone(request: CloudAgentStartRequest): Promise<CloudAgentRecord>

/** Tombstone an owned definition; immutable releases and usage Sessions remain private and recoverable.
 * @param request - owned Agent and exact revision.
 * @returns after the durable tombstone is committed.
 */
@Remote delete(request: { readonly id: CloudAgentId; readonly expectedRevision: number }): Promise<void>

/** Archive and remove only the caller's unsaved editors.
 * @param request - exact unbound editor Session identities.
 * @returns after archiving and removing private workspace registrations and files.
 */
@Remote({ resources: { session: request => request.sessionIds } }) deleteUnboundAuthoringSessions(request: { readonly sessionIds: readonly SessionId[] }): Promise<void>

/** Check selected server enablement and every pinned MCP signature before execution.
 * @param releaseId - trusted immutable release identity.
 * @param sessionId - verified member Session identity used for MCP authorization.
 */
async validateCapabilities(releaseId: string, sessionId?: SessionId): Promise<void>

/** Resolve signature-checked wrappers through the single execution provider.
 * @param releaseId - trusted release selected by the scoped runtime.
 * @param sessionId - verified member Session identity used for MCP authorization.
 * @returns release-only tools; every invocation rechecks authorization and current schema.
 */
async releaseMcpTools(releaseId: string, sessionId?: SessionId): Promise<readonly ToolDefinition[]>

/** List only attachments retained by the invoking live release Session.
 * @param agent - trusted executor initiator.
 * @returns recorded references, including compacted history.
 */
conversationFiles(agent: Agent): FileAttachmentRef[]

/** Read a bounded verified page of this conversation's attachment.
 * @param agent - trusted live initiator.
 * @param request - attachment id and bounded text offset/limit.
 * @param signal - read cancellation.
 * @returns verified UTF-8 page; no arbitrary Host path is accepted.
 */
readConversationFile(agent: Agent, request: ConversationFileReadRequest, signal: AbortSignal): Promise<ConversationFilePage>

/** Prepare a bounded report for persistence by the invoking tool pipeline.
 * @param agent - live release initiator.
 * @param name - plain filename.
 * @param content - complete report text.
 * @returns durable report metadata without a Host path.
 */
conversationReport(agent: Agent, name: string, content: string): CloudAgentReport
```

Types: [Agent](core.zh.md) · [FileAttachmentRef](attachment.zh.md) · [SessionId](core.zh.md) · [ToolDefinition](tools.zh.md)

Source: [`packages/company/cloud-agent/src/index.ts`](../../packages/company/cloud-agent/src/index.ts)

<a id="ctxcompanymcp--companymcpremote"></a>

### `ctx.companyMcp` — `CompanyMcpRemote`

Browser-safe catalog reads, refresh, enablement and discovery.

```ts cordis-catalog
/** Read the current catalog.
 * @returns servers, tools and the latest refresh failure; never endpoints or headers.
 */
@Remote catalog(): Promise<CompanyMcpCatalog>

/** Follow catalog changes.
 * @param signal - subscriber cancellation.
 * @returns the current catalog and one snapshot per change.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<CompanyMcpCatalog>

/** Refresh the catalog; a failed refresh clears inaccessible servers.
 * @param signal - caller cancellation.
 * @returns refreshed catalog or empty catalog with `failure`.
 */
@Remote refresh(signal: AbortSignal): Promise<CompanyMcpCatalog>

/** Enable or disable one server for this member.
 * @param request - server identity and enablement.
 * @returns updated catalog.
 */
@Remote configure(request: { readonly id: CompanyMcpId; readonly enabled: boolean }): Promise<CompanyMcpCatalog>

/** Refresh and read one server's tools.
 * @param request - server identity.
 * @param signal - caller cancellation.
 * @returns current tools with parameters and fingerprints.
 */
@Remote discover(request: { readonly id: CompanyMcpId }, signal: AbortSignal): Promise<readonly CompanyMcpTool[]>
```

Source: [`packages/company/mcp-provider/src/index.ts`](../../packages/company/mcp-provider/src/index.ts)

<a id="ctxcompanymcpprovider--companymcpprovider-abstract-seam"></a>

### `ctx.companyMcpProvider` — `CompanyMcpProvider` (abstract seam)

Abstract company MCP provider. Exactly one implementation registers as `ctx.companyMcpProvider`.

Implementations keep endpoints, headers and tokens private, discard inaccessible data after a failed refresh, report unknown or failed upstream outcomes as failures rather than empty results, and emit `company-mcp/changed` after every observable catalog change.

```ts cordis-catalog
/** Read a freshly authorized catalog for one verified member.
 * @param subject - verified request or Session owner, never browser input.
 * @returns servers with enablement, state and tools; `loaded` is false before the first successful refresh.
 */
abstract catalog(subject: WecomMarketSubject): Promise<CompanyMcpCatalog>

/** Replace the catalog after validating a complete upstream response.
 * @param subject - verified request or Session owner, never browser input.
 * @param signal - caller cancellation.
 * @returns the new catalog, or an empty catalog with `failure` when the refresh failed.
 */
abstract refresh(subject: WecomMarketSubject, signal?: AbortSignal): Promise<CompanyMcpCatalog>

/** Persist one member’s preference; credentials are deployment configuration, not preferences.
 * @param subject - verified request or Session owner, never browser input.
 * @param request - server identity and enablement.
 * @returns the updated catalog.
 * @throws RemoteError `company-mcp/not-found` for an unknown server.
 */
abstract configure( subject: WecomMarketSubject, request: { readonly id: CompanyMcpId; readonly enabled: boolean }, ): Promise<CompanyMcpCatalog>

/** Refresh and read one server's current tools for display.
 * @param subject - verified request or Session owner, never browser input.
 * @param id - server identity.
 * @param signal - caller cancellation.
 * @returns current tools with parameters and fingerprints.
 * @throws RemoteError when the refresh fails or the server is unknown, disabled or unavailable.
 */
abstract discover(subject: WecomMarketSubject, id: CompanyMcpId, signal: AbortSignal): Promise<readonly CompanyMcpTool[]>

/** Read one usable server's tools after fresh authorization for Agent publication.
 * @param subject - verified request or Session owner, never browser input.
 * @param id - server identity selected by an Agent.
 * @returns tools with fingerprints.
 * @throws RemoteError when the server is unauthorized, disabled or unavailable.
 */
abstract discoverTools(subject: WecomMarketSubject, id: CompanyMcpId): Promise<readonly CompanyMcpTool[]>

/** Resolve a model-facing tool for one run.
 * @param subject - verified request or Session owner, never browser input.
 * @param name - model-facing tool name.
 * @returns current schema, executable definition and fingerprint, or undefined when no server owns the name.
 * @throws RemoteError when the owning server is disabled or unavailable, or the tool no longer exists.
 */
abstract resolveTool(subject: WecomMarketSubject, name: string): Promise<CompanyMcpResolvedTool | undefined>

/** Describe the non-secret route of a model-facing tool.
 * @param subject - verified request or Session owner, never browser input.
 * @param name - model-facing tool name.
 * @returns server, raw tool name, description and fingerprint, or undefined when unknown.
 */
abstract describeTool(subject: WecomMarketSubject, name: string): Promise<CompanyMcpToolRoute | undefined>

/** Project the catalog for Agent capability selectors.
 * @param subject - verified request or Session owner, never browser input.
 * @returns server summaries without schemas.
 */
async capabilityCatalog(subject: WecomMarketSubject): Promise<readonly CompanyMcpCapability[]>

/** Stream catalog snapshots: the current one, then one per `company-mcp/changed`, coalescing bursts.
 * @param subject - verified request or Session owner, never browser input.
 * @param signal - subscriber cancellation.
 * @returns catalog snapshots until the signal aborts.
 */
async *follow(subject: WecomMarketSubject, signal: AbortSignal): AsyncIterable<CompanyMcpCatalog>
```

Source: [`packages/company/mcp-provider/src/provider.ts`](../../packages/company/mcp-provider/src/provider.ts)

<a id="ctxcompanywecomauth--companywecomauthservice"></a>

### `ctx.companyWecomAuth` — `CompanyWecomAuthService`

Required browser login; local revocation stops admission before durable writes.

```ts cordis-catalog
/** Register business grants in the calling plugin's lifecycle.
 * @param provider - committed resource ownership and explicit action grants.
 * @returns a disposer removing all grants contributed by this provider.
 */
registerResourceProvider(provider: WecomResourceProvider): () => Promise<void>

/** Build ordinary conversation and Workspace grants for business-owned Sessions.
 * @param ids - Session identities already authorized by the calling business provider.
 * @returns explicit user operations; deployment settings, filesystem mutation and native openers are excluded.
 */
sessionBindings(ids: readonly SessionId[]): RemoteAccessBinding[]

/** Resolve the current Remote caller or trusted tool initiator's company ownership scope.
 * @param member - authenticated company principal from an access-policy dispatch; omission resolves the caller.
 * @returns stable enterprise scope, or `local-owner` outside an enterprise call or initiating Session.
 * @throws WecomAuthError for unsupported non-owner principals.
 */
ownerScope(member?: CompanyUserPrincipal): CompanyOwnerScope

/** Read the current member's default Workspace Session identities for business grants.
 * @param principal - authenticated member supplied by the access-policy dispatcher.
 * @returns owned Session identities; unknown or mismatched identities return an empty list.
 */
defaultWorkspaceSessions(principal: CompanyUserPrincipal): readonly SessionId[]

/** Resolve retained ownership for a member default Workspace or business-owned Session.
 * @param sessionId - tool-initiating or source Session identity.
 * @returns stable owner, or undefined when no provider retains ownership; logout does not transfer ownership.
 */
sessionOwner(sessionId: SessionId): CompanyOwnerScope | undefined

/** Resolve verified WeCom identity for an authenticated request or an owned Session.
 * @param sessionId - trusted execution Session; omission uses the Remote caller or tool initiator.
 * @returns enterprise-scoped market subject; display names and portal ids are excluded.
 * @throws WecomAuthError when no enabled official WeCom identity owns the operation.
 */
marketSubject(sessionId?: SessionId): WecomMarketSubject

/** Begin a durable, browser-bound, single-use login attempt.
 * @param request - trusted request authority.
 * @param browserNonce - random HttpOnly browser binding.
 * @param redirect - site-local requested destination; unsafe destinations become `/`.
 * @returns public identifiers, callback URI and unpredictable state.
 */
async beginLogin(request: ConnectionTrustRequest, browserNonce: string, redirect: string | null): Promise<WecomLoginConfig>

/** Consume state before exchanging the code with official APIs.
 * @param request - callback headers including the initiating browser cookie.
 * @param input - untrusted callback fields.
 * @returns persisted member session and signed cookie; failures require a fresh login.
 */
async exchange(request: ConnectionTrustRequest, input: unknown): Promise<WecomLoginResult & { readonly cookie: string }>

/** Resolve only enabled, unexpired, unrevoked local sessions for this deployment.
 * @param request - browser cookie and authority.
 * @returns credential-free member view, or null when admission is denied.
 */
getCurrentSession(request: ConnectionTrustRequest): WecomSessionView | null

/** Revoke the local session and its Peer's streams before persistence.
 * @param request - browser cookie; absent or invalid cookies are harmless.
 * @returns completed durable revocation; storage failure keeps in-process admission denied.
 */
async logout(request: ConnectionTrustRequest): Promise<void>
```

Types: [SessionId](core.zh.md)

Source: [`packages/company/wecom-auth/src/index.ts`](../../packages/company/wecom-auth/src/index.ts)

<a id="company-mcp-events"></a>

### `company-mcp/*` events

<a id="company-mcpchanged--emit"></a>

#### `company-mcp/changed` — emit

Catalog, enablement or reported server state changed.

```ts cordis-catalog
/** Catalog, enablement or reported server state changed.
 * @mode emit
 */
'company-mcp/changed'(): void
```

Source: [`packages/company/mcp-provider/src/provider.ts`](../../packages/company/mcp-provider/src/provider.ts)
<!-- END GENERATED cordis-surface -->

<a id="dev-note"></a>
## 开发备注

无。
