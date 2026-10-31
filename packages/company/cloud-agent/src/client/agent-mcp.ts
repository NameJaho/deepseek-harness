/** Resolve session-owned drafts and exact releases without consulting the current publication pointer. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CloudAgentCatalog, CloudAgentConversation, CloudAgentId, CloudAgentOwnerId, CloudAgentRecord, CloudAgentRelease,
} from '../types.ts'

/** Metadata for one retained release; a foreign release never becomes an editable record. */
export interface ConnectedAgent {
  readonly id: CloudAgentId
  readonly ownerId: CloudAgentOwnerId
  readonly record?: CloudAgentRecord | undefined
  readonly release: CloudAgentRelease
  readonly conversation: CloudAgentConversation
}

/** Find the release recorded for this conversation, never a replacement publication.
 * @param catalog - caller-scoped directory.
 * @param sessionId - rendered conversation identity.
 * @returns retained release metadata, or absence when it cannot be read.
 */
export function connectedAgent(catalog: CloudAgentCatalog | null, sessionId: SessionId): ConnectedAgent | undefined {
  const conversation = catalog?.conversations.find(item => item.sessionId === sessionId && item.deletedAt === undefined)
  if (catalog === null || conversation?.agentId == null || conversation.releaseId === undefined) return undefined
  const record = catalog.mine.find(item => item.id === conversation.agentId)
  const owned = record?.releases.find(item => item.id === conversation.releaseId)
  if (owned !== undefined && record !== undefined) return { id: record.id, ownerId: record.ownerId, record, release: owned, conversation }
  const published = catalog.published.find(item => item.id === conversation.agentId && item.release.id === conversation.releaseId)
  if (published !== undefined) return { id: published.id, ownerId: published.ownerId, release: published.release, conversation }
  const used = catalog.usage.find(item => item.agentId === conversation.agentId && item.release?.id === conversation.releaseId)
  return used?.release === undefined ? undefined : { id: used.agentId, ownerId: used.ownerId, release: used.release, conversation }
}

/** Selected names remain visible when live metadata disappears. */
export interface AgentMcpTool { readonly name: string; readonly description: string | undefined }

/** Draft edits require an authoring association; usage always reads its exact release. */
export type AgentMcpSelection =
  | { readonly kind: 'new' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'draft'; readonly record: CloudAgentRecord; readonly tools: readonly AgentMcpTool[] }
  | ({ readonly kind: 'release'; readonly tools: readonly AgentMcpTool[] } & ConnectedAgent)

/** Resolve MCP names for one conversation.
 * @param catalog - last successful caller-scoped catalog.
 * @param sessionId - rendered conversation.
 * @param preset - current runtime preset; minimal sessions cannot edit.
 * @returns the draft or exact release selection.
 */
export function agentMcpSelection(catalog: CloudAgentCatalog, sessionId: SessionId, preset?: string | null): AgentMcpSelection {
  const descriptions = new Map(catalog.capabilities.mcpTools.map(tool => [tool.name, tool.description]))
  const tools = (names: readonly string[] = []): readonly AgentMcpTool[] =>
    [...new Set(names)].map(name => ({ name, description: descriptions.get(name) }))
  const binding = catalog.conversations.find(item => item.sessionId === sessionId && item.deletedAt === undefined)
  if (binding?.role === 'authoring' && preset !== 'minimal') {
    if (binding.agentId === null) return { kind: 'new' }
    const record = catalog.mine.find(item => item.id === binding.agentId && item.deletedAt === undefined)
    return record === undefined ? { kind: 'unavailable' } : { kind: 'draft', record, tools: tools(record.draft.mcpTools) }
  }
  const connected = connectedAgent(catalog, sessionId)
  return connected === undefined ? { kind: 'unavailable' }
    : { kind: 'release', ...connected, tools: tools(connected.release.mcpBindings?.map(binding => binding.name) ?? connected.release.definition.mcpTools) }
}
