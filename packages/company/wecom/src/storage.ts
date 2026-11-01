/** Validated non-Session routing and authorization records. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CloudAgentId, CloudAgentOwnerId, CloudAgentReleaseId } from '@deepseek-ai/dsh-company-cloud-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WecomBinding, WecomBindingId, WecomConversation, WecomConversationId, WecomRequest, WecomRequestId } from './types.ts'

const ownerId = z.preprocess(value => value ?? 'local-owner', z.string().min(1).transform(value => brandString<CloudAgentOwnerId>(value)))

const bindingId = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<WecomBindingId>(value))
const agentId = z.uuid().transform(value => brandString<CloudAgentId>(value))
const releaseId = z.uuid().transform(value => brandString<CloudAgentReleaseId>(value))
const request: z.ZodType<WecomRequest> = z.object({
  id: z.uuid().transform(value => brandString<WecomRequestId>(value)), agentId, releaseId,
  ownerId,
  name: z.string().min(1), expiresAt: z.number().int().positive(), bindingId: bindingId.nullable(),
}).strict()
const binding: z.ZodType<WecomBinding> = z.object({
  id: bindingId, ownerId, botId: z.string().min(1).max(256), agentId, releaseId,
  name: z.string().min(1), enabled: z.boolean(),
  requestId: z.uuid().transform(value => brandString<WecomRequestId>(value)),
}).strict()
const conversation: z.ZodType<WecomConversation> = z.object({
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)), bindingId, ownerId,
}).strict()

/** Unknown or malformed routing stops activation instead of selecting another agent. */
export const wecomDomain = defineDomain({ name: 'company_wecom', version: 1, tables: {
  requests: domainTable<WecomRequestId, WecomRequest>(request),
  bindings: domainTable<WecomBindingId, WecomBinding>(binding),
  conversations: domainTable<WecomConversationId, WecomConversation>(conversation),
  receipts: domainTable<string, { state: 'pending' | 'submitted'; time: number }>(z.object({
    state: z.enum(['pending', 'submitted']), time: z.number().int().nonnegative(),
  }).strict()),
} })
