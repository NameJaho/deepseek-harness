/** Durable Cloud Agent definitions and browser-safe management requests. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CompanyMcpCapability, CompanyMcpId } from '@deepseek-ai/dsh-company-mcp-provider/types'

/** Platform-assigned identity of an editable agent. */
export type CloudAgentId = Branded<'cloud-agent-id'>
/** Platform-assigned identity of an immutable runnable configuration. */
export type CloudAgentReleaseId = Branded<'cloud-agent-release-id'>
/** Account owning a definition: local-owner or a stable enterprise member scope. */
export type CloudAgentOwnerId = Branded<'cloud-agent-owner-id'>

/** User-editable configuration; credentials, endpoints and executable entries are excluded. */
export interface CloudAgentDraft {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly provider: string
  readonly model: string
  /** Exact names of deployment-configured MCP tools. Omission selects none. */
  readonly mcpTools?: readonly string[] | undefined
  /** Company MCP servers whose current tools are captured at draft save; omission selects no servers. */
  readonly mcpServers?: readonly CompanyMcpId[] | undefined
  /** Installed skill names captured at draft save. Omission selects none. */
  readonly skills?: readonly string[] | undefined
}

/** One pinned skill resource, copied into the release Session's private workspace. */
export interface CloudAgentSkillResource {
  readonly path: string
  readonly base64: string
}

/** Immutable skill instructions and resources; provider credentials are excluded. */
export interface CloudAgentSkillSnapshot {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly resources: readonly CloudAgentSkillResource[]
}

/** Tool signature used to reject a changed or missing deployment MCP binding. */
export interface CloudAgentMcpBinding {
  readonly name: string
  readonly fingerprint: string
}

/** Company MCP server summary shown by Agent plugin selectors. */
export type CloudAgentMcpServer = CompanyMcpCapability

/** Selectable deployment capabilities, without connection settings or credentials. */
export interface CloudAgentCapabilities {
  readonly mcpTools: readonly { readonly name: string; readonly description: string }[]
  /** Configured company MCP servers; tool schemas remain hidden from the selector. */
  readonly mcpServers: readonly CloudAgentMcpServer[]
  readonly skills: readonly { readonly name: string; readonly description: string }[]
}

/** Who may start a published release: every signed-in member or only its owner. */
export type CloudAgentVisibility = 'public' | 'private'

/** Conversation a release was published from; the release never copies its events. */
export interface CloudAgentReleaseSource {
  readonly sessionId: SessionId
  /** Last Session event included in the published configuration. */
  readonly throughSeq: number
  /** Creation preset of the source conversation, when recorded. */
  readonly preset?: string | undefined
  /** Permission preset of the source conversation at publication. */
  readonly permission?: string | undefined
}

/** Immutable configuration retained for published and preview sessions. */
export interface CloudAgentRelease {
  readonly id: CloudAgentReleaseId
  readonly kind: 'published' | 'preview'
  readonly version: number
  readonly draftRevision: number
  readonly definition: CloudAgentDraft
  readonly createdAt: number
  readonly skillSnapshots?: readonly CloudAgentSkillSnapshot[] | undefined
  readonly mcpBindings?: readonly CloudAgentMcpBinding[] | undefined
  readonly capabilityPreset?: string | undefined
  /** Omission on legacy published releases means public. */
  readonly visibility?: CloudAgentVisibility | undefined
  readonly source?: CloudAgentReleaseSource | undefined
  /** SHA-256 of the definition, capability bindings, skill contents and capability preset. */
  readonly digest?: string | undefined
}

/** One durable record; updating this record atomically updates its publication pointer. */
export interface CloudAgentRecord {
  readonly id: CloudAgentId
  readonly ownerId: CloudAgentOwnerId
  readonly revision: number
  readonly draft: CloudAgentDraft
  /** Host-captured tool signatures for this saved revision; publication cannot rediscover broader tools. */
  readonly draftMcpBindings?: readonly CloudAgentMcpBinding[] | undefined
  /** Host-captured skill content for this saved revision, preserved until the next explicit save. */
  readonly draftSkillSnapshots?: readonly CloudAgentSkillSnapshot[] | undefined
  /** Capability scope used when capturing this revision. */
  readonly draftCapabilityPreset?: string | undefined
  readonly releases: readonly CloudAgentRelease[]
  readonly publishedReleaseId: CloudAgentReleaseId | null
  readonly createdAt: number
  readonly updatedAt: number
  /** Deleted definitions retain immutable releases for existing conversations. */
  readonly deletedAt?: number | undefined
  /** Private authoring source; public entries contain only the selected release. */
  readonly sourceSessionId?: SessionId | undefined
  readonly sourceThroughSeq?: number | undefined
  readonly lastAuthoringRequestId?: string | undefined
}

/** Public directory entry containing only the selected release. */
export interface CloudAgentPublicEntry {
  readonly id: CloudAgentId
  readonly ownerId: CloudAgentOwnerId
  readonly release: CloudAgentRelease
}

/** Durable navigation membership; Session files remain independent. */
export interface CloudAgentConversation {
  readonly sessionId: SessionId
  readonly agentId: CloudAgentId | null
  readonly role: 'authoring' | 'usage'
  readonly releaseId?: CloudAgentReleaseId | undefined
  /** Session owner; legacy records without this field belong to local-owner. */
  readonly ownerId?: CloudAgentOwnerId | undefined
  /** Retained deletion marker prevents recovery from listing a removed unbound editor again. */
  readonly deletedAt?: number | undefined
  /** Creation preset of the release's source conversation. */
  readonly creationPreset?: string | undefined
  /** Selectable preset chosen when starting the usage Session; it never adds release capabilities. */
  readonly runPreset?: string | undefined
  /** SHA-256 of the release digest, run preset, provider, model and permission actually applied. */
  readonly effectiveDigest?: string | undefined
}

/** Compare-and-update request retaining another editor's newer work. */
export interface CloudAgentUpdateRequest {
  /** Live owning workspace-write editor or bound non-minimal conversational authoring Session; omission rejects the mutation. */
  readonly authoringSessionId?: SessionId | undefined
  readonly id: CloudAgentId
  readonly expectedRevision: number
  readonly draft: CloudAgentDraft
}

/** Publication or withdrawal targets one exact saved revision. */
export interface CloudAgentRevisionRequest {
  /** Live owning workspace-write editor or bound non-minimal conversational authoring Session; omission rejects the mutation. */
  readonly authoringSessionId?: SessionId | undefined
  readonly id: CloudAgentId
  readonly expectedRevision: number
}

/** Publication of one saved revision with its audience. */
export interface CloudAgentPublishRequest extends CloudAgentRevisionRequest {
  /** Omission publishes to every signed-in member. */
  readonly visibility?: CloudAgentVisibility | undefined
}

/** Public runs pin the release displayed by the directory card. */
export interface CloudAgentStartRequest {
  /** Owner-authorized authoring Session required for cloning; ignored when starting a usage Session. */
  readonly authoringSessionId?: SessionId | undefined
  readonly id: CloudAgentId
  readonly releaseId: CloudAgentReleaseId
  /** Selectable preset recorded for this run; omission uses the deployment default. */
  readonly runPreset?: string | undefined
  /** Provider and model override; capabilities remain those of the release. */
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** The ordinary DSH session created from a release or preview snapshot. */
export interface CloudAgentSession {
  readonly sessionId: SessionId
  readonly releaseId: CloudAgentReleaseId
}

/** Complete downloadable text report persisted in its conversation's tool-result metadata. */
export interface CloudAgentReport {
  readonly name: string
  readonly content: string
  readonly mediaType: string
  readonly bytes: number
}

/**
 * State of a used Agent from the caller's view: `updated` means a newer release than the bound one is published,
 * `withdrawn` means no release is published, `access-lost` means the published release is private to another owner,
 * and `disabled` means a selected company MCP server is disabled.
 */
export type CloudAgentUsageStatus = 'available' | 'updated' | 'withdrawn' | 'deleted' | 'access-lost' | 'disabled'

/** One Agent the caller has used; navigation keeps one workspace group per entry. */
export interface CloudAgentUsageEntry {
  readonly agentId: CloudAgentId
  readonly ownerId: CloudAgentOwnerId
  /** Name of the latest release the caller used. */
  readonly name: string
  readonly status: CloudAgentUsageStatus
  /** Latest release the caller may start; omitted when status forbids new runs. */
  readonly release?: CloudAgentRelease | undefined
}

/** Directory and model choices returned to the authoring page. */
export interface CloudAgentCatalog {
  readonly conversations: readonly CloudAgentConversation[]
  readonly mine: readonly CloudAgentRecord[]
  readonly published: readonly CloudAgentPublicEntry[]
  readonly usage: readonly CloudAgentUsageEntry[]
  readonly models: ModelCatalog
  readonly capabilities: CloudAgentCapabilities
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Pinned Agent release and private Session ownership; inherited forks retain this owner. */
    'cloud-agent/binding': CloudAgentConversation
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'cloud-agent/invalid-input': { readonly reason: string }
    'cloud-agent/not-found': { readonly id: string }
    'cloud-agent/conflict': { readonly currentRevision: number }
    'cloud-agent/not-published': { readonly id: string }
    'cloud-agent/authoring-required': Record<string, never>
    'cloud-agent/owner-required': Record<string, never>
    'cloud-agent/unavailable': Record<string, never>
    'cloud-agent/capability-unavailable': { readonly name: string }
    'cloud-agent/preset-unavailable': { readonly id: string }
  }
}
