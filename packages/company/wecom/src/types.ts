/** Browser-safe WeCom publication and persistent binding identities. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CloudAgentId, CloudAgentOwnerId, CloudAgentReleaseId } from '@deepseek-ai/dsh-company-cloud-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A short-lived authorization request, never a robot credential. */
export type WecomRequestId = Branded<'wecom-request-id'>
/** A deployment-local robot binding. */
export type WecomBindingId = Branded<'wecom-binding-id'>
/** A hashed robot conversation identity. */
export type WecomConversationId = Branded<'wecom-conversation-id'>
/** One exact saved Cloud Agent version awaiting authorization. */
export interface WecomRequest {
  id: WecomRequestId
  ownerId: CloudAgentOwnerId
  agentId: CloudAgentId
  releaseId: CloudAgentReleaseId
  name: string
  expiresAt: number
  bindingId: WecomBindingId | null
}
/** Persistent routing; the Secret is held separately by the credential provider. */
export interface WecomBinding {
  id: WecomBindingId
  ownerId: CloudAgentOwnerId
  botId: string
  agentId: CloudAgentId
  releaseId: CloudAgentReleaseId
  name: string
  enabled: boolean
  requestId: WecomRequestId
}
/** The official browser authorization result plus the pending request identity. */
export interface WecomAuthorization {
  requestId: WecomRequestId
  botId: string
  secret: string
}
/** Management state excludes every credential value. */
export interface WecomSnapshot {
  source: string
  requests: WecomRequest[]
  bindings: (WecomBinding & { status: 'connecting' | 'online' | 'offline' | 'disabled' })[]
}
/** One robot conversation's durable Harness Session. */
export interface WecomConversation {
  sessionId: SessionId
  bindingId: WecomBindingId
  ownerId: CloudAgentOwnerId
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'wecom/agent-required': Record<string, never>
    'wecom/owner-required': Record<string, never>
    'wecom/invalid-authorization': Record<string, never>
    'wecom/authorization-uncertain': Record<string, never>
    'wecom/delivery-uncertain': Record<string, never>
    'wecom/expired': Record<string, never>
    'wecom/already-bound': Record<string, never>
    'wecom/release-changed': Record<string, never>
    'wecom/limit': Record<string, never>
    'wecom/not-found': Record<string, never>
    'wecom/stopping': Record<string, never>
  }
}
