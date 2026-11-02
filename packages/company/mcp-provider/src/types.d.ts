/** Browser-safe company MCP catalog fields; endpoints, headers and tokens never appear in these types. */
import type { Branded } from '@deepseek-ai/dsh-brand'
/** Stable server identity supplied by the external MCP interface. */
export type CompanyMcpId = Branded<'company-mcp-id'>
/** Connection state reported by the external interface; every value has a text label in the UI. */
export type CompanyMcpStatus = 'available' | 'connecting' | 'failed' | 'maintenance'
/** One tool exposed by a server; `parametersJson` keeps the Remote schema finite. */
export interface CompanyMcpTool {
  /** Deterministic model-facing name, `mcp__company_<hash>__<rawName>` within 64 characters. */
  readonly name: string
  /** Upstream tool name sent to the external interface. */
  readonly rawName: string
  readonly description: string
  /** JSON-encoded parameter JSON Schema. */
  readonly parametersJson: string
  /** SHA-256 of the model-facing schema; releases pin it and runs reject a different value. */
  readonly fingerprint: string
}
/** One server summary with the member's current Market authorization and state. */
export interface CompanyMcpServer {
  readonly id: CompanyMcpId
  readonly name: string
  readonly description: string
  /** Market authorization has already filtered this server for the member. */
  readonly enabled: boolean
  readonly status: CompanyMcpStatus
  /** Upstream update time in epoch milliseconds, when reported. */
  readonly updatedAt?: number | undefined
  /** Tool count from the directory; schemas load only on explicit discovery. */
  readonly toolCount?: number | undefined
  readonly tools: readonly CompanyMcpTool[]
}
/** Sanitized failure of the latest refresh; never contains endpoints or response bodies. */
export interface CompanyMcpFailure {
  readonly code: CompanyMcpErrorCode
  readonly message: string
}
/**
 * Catalog snapshot. `loaded` is false until one refresh succeeds, so an unavailable catalog is never an empty one.
 * A failed refresh clears `servers` and exposes `failure`; stale data never grants access.
 */
export interface CompanyMcpCatalog {
  readonly loaded: boolean
  readonly servers: readonly CompanyMcpServer[]
  /** Epoch milliseconds of the last successful refresh. */
  readonly refreshedAt?: number | undefined
  readonly failure?: CompanyMcpFailure | undefined
}
/** Server summary used by Agent capability selectors; it has no schemas. */
export interface CompanyMcpCapability {
  readonly id: CompanyMcpId
  readonly name: string
  readonly namespace: string
  readonly description: string
  readonly enabled: boolean
  readonly status: CompanyMcpStatus
  readonly toolNames: readonly string[]
  readonly toolCount?: number | undefined
}
/** Non-secret route of one model-facing tool. */
export interface CompanyMcpToolRoute {
  readonly serverId: CompanyMcpId
  readonly rawName: string
  readonly description: string
  readonly fingerprint: string
}
/** Stable sanitized company MCP failure identifiers. */
export type CompanyMcpErrorCode = 'company-mcp/catalog-unavailable' | 'company-mcp/invalid-response' | 'company-mcp/not-found' | 'company-mcp/disabled' | 'company-mcp/unavailable' | 'company-mcp/tool-changed' | 'company-mcp/call-failed' | 'company-mcp/stopping' | 'company-mcp/forbidden' | 'company-mcp/member-unresolved' | 'company-mcp/call-unavailable' | 'company-mcp/call-outcome-unknown'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'company-mcp/catalog-unavailable': Record<string, never>
    'company-mcp/invalid-response': {
      readonly reason: string
    }
    'company-mcp/not-found': {
      readonly id: string
    }
    'company-mcp/disabled': {
      readonly id: string
    }
    'company-mcp/unavailable': {
      readonly id: string
      readonly status: CompanyMcpStatus
    }
    'company-mcp/tool-changed': {
      readonly name: string
    }
    'company-mcp/call-failed': {
      readonly name: string
      readonly reason: string
    }
    'company-mcp/forbidden': Record<string, never>
    'company-mcp/member-unresolved': Record<string, never>
    'company-mcp/call-unavailable': Record<string, never>
    'company-mcp/call-outcome-unknown': {
      readonly name: string
      readonly reason: string
    }
    'company-mcp/stopping': Record<string, never>
  }
}
//# sourceMappingURL=types.d.ts.map
