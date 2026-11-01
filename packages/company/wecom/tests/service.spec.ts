import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CloudAgentOwnerId } from '@deepseek-ai/dsh-company-cloud-agent/types'
import { Config } from '../src/config.ts'
import { routingHash } from '../src/channel.ts'
import type { WecomBinding, WecomRequest, WecomConversation } from '../src/types.ts'

describe('Company WeCom contracts', () => {
  it('validates deployment bounds and keeps the robot secret outside configuration', () => {
    const config = Config({ source: 'test', wsUrl: 'wss://example.invalid', authorizationTimeoutMs: 1000, responseTimeoutMs: 1000,
      maxBindings: 2, maxQueuedMessages: 2, maxInputChars: 100, maxReplyBytes: 128, maxRequests: 2, maxConversations: 2, maxReceipts: 2 })
    expect(config.source).toBe('test')
    expect(config.wsUrl).toBe('wss://example.invalid')
    expect(config).not.toHaveProperty('secret')
  })

  it('requires one owner scope on every durable routing record', () => {
    const ownerId = brandString<CloudAgentOwnerId>('wecom:corp:member')
    const request: WecomRequest = {
      id: brandString<WecomRequest['id']>('request'), ownerId, agentId: brandString<WecomRequest['agentId']>('agent'), releaseId: brandString<WecomRequest['releaseId']>('release'),
      name: 'Agent', expiresAt: Date.now() + 1000, bindingId: null,
    }
    const binding: WecomBinding = {
      id: brandString<WecomBinding['id']>('binding'), ownerId, botId: 'bot', agentId: request.agentId, releaseId: request.releaseId,
      name: request.name, enabled: true, requestId: request.id,
    }
    const conversation: WecomConversation = { sessionId: brandString<WecomConversation['sessionId']>('session'), bindingId: binding.id, ownerId }
    expect(request.ownerId).toBe(ownerId)
    expect(binding.ownerId).toBe(ownerId)
    expect(conversation.ownerId).toBe(ownerId)
  })

  it('hashes robot routes deterministically without exposing source identifiers', () => {
    expect(routingHash('bot', 'conversation')).toBe(routingHash('bot', 'conversation'))
    expect(routingHash('bot', 'conversation')).not.toContain('conversation')
  })
})
