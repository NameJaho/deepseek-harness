/** Public, credential-free user MCP catalog values. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable MCP name supplied to the platform token exchange endpoint. */
export type UserMcpId = Branded<'user-mcp-id'>

/** One MCP server the authenticated user may use. */
export interface UserMcpSummary {
  readonly id: UserMcpId
  readonly displayName: string
  readonly description: string
  readonly environment: string
  readonly accessType: 'open' | 'authorized' | 'unknown'
}

/** The user-facing catalog returned by the Host service. */
export interface UserMcpCatalog {
  readonly userId: string
  readonly entries: readonly UserMcpSummary[]
}

/** Internal normalized record retained only for connection setup. */
export interface UserMcpTarget extends UserMcpSummary {
  readonly mcpName: string
}
