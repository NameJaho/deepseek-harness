import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { ExternalAgentError } from '../src/error.ts'
import { agentConfig, ANSWER, httpFixture, parentAgent, setup } from './fixture.ts'

function expectFailure(value: SubagentResult, code: string): void {
  expect(value).toMatchObject({ stopReason: 'error', output: [] })
  expect(value.diagnostic).toContain(code)
  expect(JSON.stringify(value)).not.toContain('fixture-secret')
  expect(JSON.stringify(value)).not.toContain('/v1/chat-messages')
}

describe('external agent blocking HTTP provider', () => {
  it('sends only documented fields and retains safe association and complete result', async () => {
    const http = await httpFixture()
    const resolver = vi.fn(async () => ({ value: 'fixture-secret', source: 'fixture' }))
    const f = await setup(agentConfig(http.endpoint), resolver)
    const run = await f.start()
    expect(f.service.describeRun(f.id, f.parent, run.childId).state).toEqual({ status: 'running' })
    expect(await run.result).toEqual({ output: [{ type: 'text', text: ANSWER.answer }], stopReason: 'completed' })
    const sent = http.requests[0]!
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe('/v1/chat-messages')
    expect(sent.headers.authorization).toBe('Bearer fixture-secret')
    expect(sent.body.user).toMatch(/^[a-f0-9]{64}$/)
    expect(sent.body).toEqual({ inputs: { language: 'zh' }, query: 'Research this question', response_mode: 'blocking', user: sent.body.user })
    expect(resolver).toHaveBeenCalledWith('DIFY_TEST_KEY')
    const record = f.service.describeRun(f.id, f.parent, run.childId)
    expect(record).toMatchObject({ childId: run.childId, parentSessionId: f.parent.id, state: { status: 'completed', output: { bytes: Buffer.byteLength(ANSWER.answer) } } })
    expect(JSON.stringify(record)).not.toContain(http.endpoint)
    expect(JSON.stringify(record)).not.toContain('DIFY_TEST_KEY')
    expect(JSON.stringify(record)).not.toContain(ANSWER.answer)
    await run.dispose()
    await run.dispose()
    expect(f.ctx.subagents.getProvider('external-research')).toMatchObject({ inheritsParentContext: false, capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } })
  })

  it('re-resolves credentials, continues only the owned latest child and preserves the Dify user', async () => {
    const http = await httpFixture()
    let token = 'first-token'
    const f = await setup(agentConfig(http.endpoint), async () => ({ value: token, source: 'fixture' }))
    const first = await f.start()
    await first.result
    token = 'second-token'
    const second = await f.start('Continue explicitly', undefined, first.childId)
    await second.result
    expect(http.requests[1]!.headers.authorization).toBe('Bearer second-token')
    expect(http.requests[1]!.body.conversation_id).toBe('conversation-one')
    expect(http.requests[1]!.body.user).toBe(http.requests[0]!.body.user)
    expect(f.service.describeRun(f.id, f.parent, second.childId).continuationOf).toBe(first.childId)
    await expect(f.start('stale', undefined, first.childId)).rejects.toMatchObject({ failure: { code: 'continuation-unavailable' } })
    const other = await parentAgent(f.ctx)
    await expect(f.start('foreign', undefined, second.childId, other)).rejects.toMatchObject({ failure: { code: 'continuation-owner' } })
    await expect(f.start('missing', undefined, SessionId('missing'))).rejects.toMatchObject({ failure: { code: 'continuation-unavailable' } })
    const fresh = await f.start('New independent question')
    await fresh.result
    expect(http.requests[2]!.body).not.toHaveProperty('conversation_id')
  })

  it('rejects concurrent continuation without sending it, then blocks an unknown conversation', async () => {
    const continuationSeen = Promise.withResolvers<undefined>()
    const http = await httpFixture((res, _req, index) => {
      if (index === 1) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(ANSWER)) }
      else continuationSeen.resolve(undefined)
    })
    const f = await setup(agentConfig(http.endpoint))
    const first = await f.start()
    await first.result
    const next = await f.start('continue', undefined, first.childId)
    await continuationSeen.promise
    await expect(f.start('overlap', undefined, first.childId)).rejects.toMatchObject({ failure: { code: 'continuation-busy' } })
    await next.dispose()
    const outcome = await next.result
    expect(outcome).toMatchObject({ stopReason: 'aborted', output: [] })
    expect(outcome.diagnostic).toContain('unknown')
    await expect(f.start('uncertain', undefined, first.childId)).rejects.toMatchObject({ failure: { code: 'continuation-unavailable' } })
    expect(http.requests).toHaveLength(2)
  })

  it('rejects continuation when disabled and rejects a foreign logical agent', async () => {
    const http = await httpFixture()
    const f = await setup(agentConfig(http.endpoint, { allowContinuation: false }))
    const first = await f.start()
    await first.result
    await expect(f.start('continue', undefined, first.childId)).rejects.toMatchObject({ failure: { code: 'continuation-disabled' } })
    const other = await setup(agentConfig(http.endpoint, { id: 'other', providerName: 'external-other' }))
    await expect(other.start('foreign', undefined, first.childId)).rejects.toMatchObject({ failure: { code: 'continuation-unavailable' } })
    expect(http.requests).toHaveLength(1)
  })

  it('bounds the complete encoded body at an exact multibyte limit', async () => {
    const query = '中文'
    const body = JSON.stringify({ inputs: { language: 'zh' }, query, response_mode: 'blocking', user: 'a'.repeat(64) })
    const bytes = Buffer.byteLength(body)
    const http = await httpFixture()
    const exact = await setup(agentConfig(http.endpoint, { maxInputBytes: bytes }))
    const success = await exact.start(query)
    expect((await success.result).stopReason).toBe('completed')
    const small = await setup(agentConfig(http.endpoint, { maxInputBytes: bytes - 1 }))
    const failed = await small.start(query)
    expectFailure(await failed.result, 'input-limit')
    expect(http.requests).toHaveLength(1)
    expect(small.service.describeRun(small.id, small.parent, failed.childId).state).toMatchObject({ failure: { effect: 'not-sent' } })
  })

  it.each([
    ['unknown event', { ...ANSWER, event: 'message_end' }, 'response-format'],
    ['unknown mode', { ...ANSWER, mode: 'future-mode' }, 'response-format'],
    ['missing conversation', { ...ANSWER, conversation_id: null }, 'response-format'],
    ['missing message', { ...ANSWER, message_id: '' }, 'response-format'],
    ['partial fields', { answer: 'partial' }, 'response-format'],
    ['empty answer', { ...ANSWER, answer: '' }, 'response-format'],
    ['escaped invalid Unicode', { ...ANSWER, answer: '\ud800' }, 'response-format'],
    ['null', null, 'response-format'],
  ])('rejects %s rather than publishing partial output', async (_label, payload, code) => {
    const http = await httpFixture((res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)) })
    const f = await setup(agentConfig(http.endpoint))
    const run = await f.start()
    expectFailure(await run.result, code)
    expect(f.service.describeRun(f.id, f.parent, run.childId).state).toMatchObject({ status: 'failed', failure: { code, effect: 'unknown' } })
  })

  it.each([
    ['malformed JSON', Buffer.from('{"answer":"partial'), 'application/json', 'response-format'],
    ['malformed UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), 'application/json', 'response-encoding'],
    ['UTF-8 BOM', Buffer.from('\ufeff' + JSON.stringify(ANSWER)), 'application/json', 'response-format'],
    ['wrong charset', Buffer.from(JSON.stringify(ANSWER)), 'application/json; charset=latin1', 'response-encoding'],
    ['unmatched charset quote', Buffer.from(JSON.stringify(ANSWER)), 'application/json; charset="utf-8', 'response-encoding'],
    ['stream response', Buffer.from('data: answer'), 'text/event-stream', 'response-encoding'],
  ])('rejects %s', async (_label, body, type, code) => {
    const http = await httpFixture((res) => { res.setHeader('Content-Type', type); res.end(body) })
    const f = await setup(agentConfig(http.endpoint))
    expectFailure(await (await f.start()).result, code)
  })

  it('accepts documented Chatflow mode but strips unrelated metadata', async () => {
    const http = await httpFixture((res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ...ANSWER, mode: 'advanced-chat', id: 'event-id', metadata: { endpoint: 'private-url', credential: 'fixture-secret' } }))
    })
    const f = await setup(agentConfig(http.endpoint))
    expect(await (await f.start()).result).toEqual({ output: [{ type: 'text', text: ANSWER.answer }], stopReason: 'completed' })
  })

  it.each([302, 400, 404, 408, 429, 500])('keeps HTTP %d as a safe failure without replay or redirects', async (status) => {
    const http = await httpFixture((res) => { res.statusCode = status; res.setHeader('Location', '/secret-target'); res.end('fixture-secret private endpoint') })
    const f = await setup(agentConfig(http.endpoint))
    const run = await f.start()
    expectFailure(await run.result, 'http-status')
    expect(f.service.describeRun(f.id, f.parent, run.childId).state).toMatchObject({ failure: { httpStatus: status } })
    expect(http.requests).toHaveLength(1)
  })

  it.each([false, true])('bounds responses with and without content-length (%s)', async (chunked) => {
    const http = await httpFixture((res) => {
      res.setHeader('Content-Type', 'application/json')
      const body = JSON.stringify({ ...ANSWER, answer: '中'.repeat(1000) })
      if (chunked) { res.write(body); res.end() } else res.end(body)
    })
    const f = await setup(agentConfig(http.endpoint, { maxOutputBytes: 512 }))
    expectFailure(await (await f.start()).result, 'response-size')
  })

  it('accepts an exact response byte limit and rejects one byte less', async () => {
    const bytes = Buffer.byteLength(JSON.stringify(ANSWER))
    const http = await httpFixture()
    const exact = await setup(agentConfig(http.endpoint, { maxOutputBytes: bytes }))
    expect((await (await exact.start()).result).stopReason).toBe('completed')
    const small = await setup(agentConfig(http.endpoint, { maxOutputBytes: bytes - 1 }))
    expectFailure(await (await small.start()).result, 'response-size')
  })

  it('marks a truncated body and connection reset as unknown failures', async () => {
    const http = await httpFixture((res) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', '200')
      res.write('{"answer":"partial')
      res.destroy()
    })
    const f = await setup(agentConfig(http.endpoint))
    expectFailure(await (await f.start()).result, 'transport')
  })

  it('rejects a changed remote conversation id and invalidates continuation', async () => {
    const http = await httpFixture((res, _req, index) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ...ANSWER, conversation_id: index === 1 ? 'conversation-one' : 'conversation-other' }))
    })
    const f = await setup(agentConfig(http.endpoint))
    const first = await f.start()
    await first.result
    expectFailure(await (await f.start('continue', undefined, first.childId)).result, 'response-format')
    await expect(f.start('cannot continue', undefined, first.childId)).rejects.toMatchObject({ failure: { code: 'continuation-unavailable' } })
  })

  it('times out a dispatched call and retains unknown effect instead of success', async () => {
    const http = await httpFixture(() => {})
    const f = await setup(agentConfig(http.endpoint, { timeoutMs: 100 }))
    const run = await f.start()
    await http.received
    expectFailure(await run.result, 'timeout')
    expect(f.service.describeRun(f.id, f.parent, run.childId).state).toMatchObject({ failure: { code: 'timeout', effect: 'unknown' } })
  })

  it('disposes all active siblings and removes registration while retaining descriptors', async () => {
    const bothSeen = Promise.withResolvers<undefined>()
    const http = await httpFixture((_res, _req, index) => { if (index === 2) bothSeen.resolve(undefined) })
    const f = await setup(agentConfig(http.endpoint))
    const first = await f.start('first')
    const second = await f.start('second')
    await bothSeen.promise
    await f.fiber.dispose()
    expect((await first.result).stopReason).toBe('aborted')
    expect((await second.result).stopReason).toBe('aborted')
    expect(f.ctx.subagents.getProvider('external-research')).toBeUndefined()
    expect(f.service.catalog()[0]!.status).toBe('disposed')
    expect(f.service.describeRun(f.id, f.parent, first.childId).state).toMatchObject({ status: 'failed' })
  })

  it('contains delayed credential settlement after disposal without a late HTTP dispatch', async () => {
    const credential = Promise.withResolvers<{ value: string; source: string }>()
    const resolving = Promise.withResolvers<undefined>()
    const http = await httpFixture()
    const f = await setup(agentConfig(http.endpoint), () => { resolving.resolve(undefined); return credential.promise })
    const run = await f.start()
    await resolving.promise
    await f.fiber.dispose()
    expect((await run.result).stopReason).toBe('aborted')
    credential.resolve({ value: 'late-secret', source: 'fixture' })
    await credential.promise
    expect(http.requests).toHaveLength(0)
  })

  it('contains a synchronous credential error and does not couple sibling settlement', async () => {
    const http = await httpFixture()
    let calls = 0
    const f = await setup(agentConfig(http.endpoint), () => {
      if (++calls === 1) throw new Error('fixture-secret credential failure')
      return Promise.resolve({ value: 'fixture-secret', source: 'fixture' })
    })
    const first = await f.start()
    const second = await f.start()
    expectFailure(await first.result, 'credential-unavailable')
    expect((await second.result).stopReason).toBe('completed')
    await f.fiber.dispose()
  })

  it('bounds credential resolution and observes late rejection', async () => {
    const credential = Promise.withResolvers<never>()
    const http = await httpFixture()
    const f = await setup(agentConfig(http.endpoint, { timeoutMs: 20 }), () => credential.promise)
    const run = await f.start()
    expectFailure(await run.result, 'timeout')
    credential.reject(new Error('late secret failure'))
    expect(f.service.describeRun(f.id, f.parent, run.childId).state).toMatchObject({ failure: { effect: 'not-sent' } })
    expect(http.requests).toHaveLength(0)
  })

  it('rejects missing credentials and retains capacity facts rather than dropping records', async () => {
    const http = await httpFixture()
    const f = await setup(agentConfig(http.endpoint, { maxRetainedRuns: 1 }), async () => undefined)
    const first = await f.start()
    expectFailure(await first.result, 'credential-unavailable')
    await expect(f.start()).rejects.toMatchObject({ failure: { code: 'capacity' } })
    expect(f.service.describeRun(f.id, f.parent, first.childId).state).toMatchObject({ status: 'failed' })
    expect(http.requests).toHaveLength(0)
  })

  it('cancels body consumption through the provider signal and observes repeated disposal', async () => {
    const bodyStarted = Promise.withResolvers<undefined>()
    const http = await httpFixture((res) => {
      res.setHeader('Content-Type', 'application/json')
      res.write('{"answer":"partial')
      bodyStarted.resolve(undefined)
    })
    const f = await setup(agentConfig(http.endpoint))
    const provider = f.ctx.subagents.getProvider('external-research')!
    const controller = new AbortController()
    const run = await provider.start!({ parent: f.parent, cwd: process.cwd(), signal: controller.signal, prompt: [{ type: 'text', text: 'Read completely' }] })
    await bodyStarted.promise
    controller.abort()
    const outcome = await run.result
    expect(outcome).toMatchObject({ stopReason: 'aborted', output: [] })
    expect(outcome.diagnostic).toContain('unknown')
    await Promise.all([run.dispose(), run.dispose(), f.fiber.dispose()])
    await expect(provider.start!({ parent: f.parent, cwd: process.cwd(), signal: new AbortController().signal, prompt: [{ type: 'text', text: 'late' }] })).rejects.toMatchObject({ failure: { code: 'disposed' } })
    expect(http.requests).toHaveLength(1)
  })

  it('does not send a continuation after credential failure and permits an explicit retry of the old tail', async () => {
    const http = await httpFixture()
    let resolveCredential = true
    const f = await setup(agentConfig(http.endpoint), async () => resolveCredential ? { value: 'fixture-secret', source: 'fixture' } : undefined)
    const first = await f.start()
    await first.result
    resolveCredential = false
    const failed = await f.start('continue', undefined, first.childId)
    expectFailure(await failed.result, 'credential-unavailable')
    expect(f.service.describeRun(f.id, f.parent, failed.childId).state).toMatchObject({ failure: { effect: 'not-sent' } })
    resolveCredential = true
    expect((await (await f.start('explicit retry', undefined, first.childId)).result).stopReason).toBe('completed')
    expect(http.requests).toHaveLength(2)
  })

  it('rejects aborted and invalid prompts before HTTP, without inheriting start options', async () => {
    const http = await httpFixture()
    const f = await setup(agentConfig(http.endpoint))
    const provider = f.ctx.subagents.getProvider('external-research')!
    const base = { parent: f.parent, cwd: process.cwd(), signal: new AbortController().signal }
    await expect(provider.start!({ ...base, prompt: [{ type: 'text', text: '\ud800' }] })).rejects.toBeInstanceOf(ExternalAgentError)
    await expect(provider.start!({ ...base, prompt: [] })).rejects.toMatchObject({ failure: { code: 'invalid-input' } })
    await expect(provider.start!({ ...base, prompt: [{ type: 'text', text: ' ' }] })).rejects.toMatchObject({ failure: { code: 'invalid-input' } })
    await expect(provider.start!({ ...base, prompt: [{ type: 'text', text: 'x' }], agentOptions: {} })).rejects.toMatchObject({ failure: { code: 'configuration' } })
    await expect(f.start('cancel', AbortSignal.abort())).rejects.toThrow()
    expect(http.requests).toHaveLength(0)
  })
})
