/** Deployment validation and adapter-independent complete-result bounds. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { describe, expect, it, onTestFinished } from 'vitest'
import ExternalAgents, { type ExternalAgentConfig } from '../src/index.ts'
import type { ExternalAgentAnswer } from '../src/dify.ts'
import { ExternalPlatformProvider } from '../src/provider.ts'
import { agentConfig, FixtureCredentials, registries, setup } from './fixture.ts'

describe('external agent private configuration', () => {
  it.each<Partial<ExternalAgentConfig>>([
    { endpoint: 'http://example.com/v1/chat-messages' },
    { endpoint: 'https://user:secret@example.com/v1/chat-messages' },
    { endpoint: 'https://example.com/v1/chat-messages?secret=token' },
    { endpoint: 'https://example.com/v1/chat-messages#secret' },
    { endpoint: 'https://example.com/v1/workflows/run' },
    { endpoint: 'not a URL' },
    { credentialRef: 'a bearer token' },
    { id: 'with spaces' }, { name: ' ' }, { providerName: 'Invalid' },
    { timeoutMs: MAX_TIMER_DELAY_MS + 1 }, { timeoutMs: 0 },
    { maxInputBytes: 1 }, { maxOutputBytes: 0 }, { maxRetainedRuns: 1.5 },
    { inputs: { invalid: Number.NaN } },
    { inputs: { nested: ['\ud800'] } },
    { inputs: { 'invalid\u0000key': 'value' } },
  ])('rejects invalid deployment before registering a backend (%j)', async (overrides) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await registries(ctx)
    await ctx.plugin(FixtureCredentials, { resolve: async () => undefined })
    await expect(ctx.plugin(ExternalAgents, { agents: [agentConfig('https://example.com/v1/chat-messages', overrides)] })).rejects.toThrow()
    expect(ctx.subagents.getProvider('external-research')).toBeUndefined()
  })

  it.each(['id', 'providerName'] as const)('validates duplicate %s before any registrations', async (field) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await registries(ctx)
    await ctx.plugin(FixtureCredentials, { resolve: async () => undefined })
    const first = agentConfig('https://example.com/v1/chat-messages')
    const second = { ...first, id: 'another', providerName: 'external-another', [field]: first[field] }
    await expect(ctx.plugin(ExternalAgents, { agents: [first, second] })).rejects.toMatchObject({ failure: { code: 'configuration' } })
    expect(ctx.subagents.getProvider(first.providerName)).toBeUndefined()
  })

  it('has no providers when explicitly configured with an empty catalog', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await registries(ctx)
    await ctx.plugin(FixtureCredentials, { resolve: async () => undefined })
    await ctx.plugin(ExternalAgents, { agents: [] })
    expect(ctx.externalAgentSubagents.catalog()).toEqual([])
  })

  it('bounds the complete emitted envelope for a replacement platform adapter', async () => {
    const f = await setup(agentConfig('https://example.com/v1/chat-messages'))
    const answer: ExternalAgentAnswer = {
      answer: '中文"'.repeat(30),
      conversationId: brandString<ExternalAgentAnswer['conversationId']>('private-conversation'),
      messageId: brandString<ExternalAgentAnswer['messageId']>('private-message'),
    }
    const completed = { output: [{ type: 'text', text: answer.answer }], stopReason: 'completed' }
    const limit = Buffer.byteLength(JSON.stringify(completed))
    for (const bytes of [limit, limit - 1]) {
      const provider = new ExternalPlatformProvider(f.ctx, {
        descriptor: f.service.catalog()[0]!, credentialRef: credentialRef('DIFY_TEST_KEY'),
        timeoutMs: 1000, maxInputBytes: 4096, maxOutputBytes: bytes, maxRetainedRuns: 1,
      }, { call: async (_call, sent) => { sent(); return answer } })
      onTestFinished(() => provider.dispose())
      const run = await provider.start({ parent: f.parent, cwd: process.cwd(), signal: new AbortController().signal, prompt: [{ type: 'text', text: 'standalone task' }] })
      const result = await run.result
      expect(result).toMatchObject(bytes === limit ? completed : { output: [], stopReason: 'error' })
      if (bytes !== limit) expect(result.diagnostic).toContain('response-size')
      await provider.dispose()
    }
  })
})
