import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { WSClient, WSClientEventMap, WSClientOptions, TextMessage, WsFrame } from '@wecom/aibot-node-sdk'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { boundedReply, routingHash, WecomChannel, type WecomAdmission } from '../src/channel.ts'
import type { Config } from '../src/config.ts'
import type { WecomBinding, WecomSnapshot } from '../src/types.ts'

type SocketEvents = { [K in keyof WSClientEventMap]: Parameters<WSClientEventMap[K]> }
type TestSocket = EventEmitter<SocketEvents> & {
  options: WSClientOptions
  connect: Mock<() => void>
  disconnect: Mock<() => void>
  replyStream: Mock<WSClient['replyStream']>
}
const sdk = vi.hoisted(() => ({ instances: [] as TestSocket[] }))
vi.mock('@wecom/aibot-node-sdk', async () => {
  const { EventEmitter } = await import('node:events')
  class Socket extends EventEmitter<SocketEvents> {
    constructor(readonly options: WSClientOptions) {
      super()
      sdk.instances.push(this)
    }
    connect = vi.fn<() => void>()
    disconnect = vi.fn(() => { this.emit('disconnected', 'closed') })
    replyStream = vi.fn<WSClient['replyStream']>().mockResolvedValue({ headers: { req_id: 'ack' }, errcode: 0 })
  }
  return { WSClient: Socket }
})

const config: Config = {
  source: 'test', wsUrl: 'wss://wecom.invalid', authorizationTimeoutMs: 1000,
  responseTimeoutMs: 1000, maxBindings: 2, maxQueuedMessages: 4, maxInputChars: 100,
  maxReplyBytes: 128, maxRequests: 10, maxConversations: 10, maxReceipts: 10,
}
const binding: WecomBinding = {
  id: brandString<WecomBinding['id']>('binding'), ownerId: brandString<WecomBinding['ownerId']>('local-owner'), botId: 'robot',
  agentId: brandString<WecomBinding['agentId']>('agent'),
  releaseId: brandString<WecomBinding['releaseId']>('release'), name: 'test', enabled: true,
  requestId: brandString<WecomBinding['requestId']>('request'),
}
const cleanups: (() => Promise<void>)[] = []

function frame(msgid = 'message', body: Partial<TextMessage> = {}): WsFrame<TextMessage> {
  return {
    cmd: 'aibot_msg_callback', headers: { req_id: `request-${msgid}` },
    body: {
      msgid, aibotid: 'robot', chattype: 'single', from: { userid: 'user' },
      msgtype: 'text' as TextMessage['msgtype'], text: { content: 'Hello' }, ...body,
    },
  }
}

function fixture(options: { manual?: boolean; manualDrain?: boolean; config?: Partial<Config> } = {}) {
  const ctx = new Context()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const session = Session.create(SessionId('wecom-test'))
  const started = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  let activity: PromiseWithResolvers<undefined> | undefined
  let turn = 0
  let status: Agent['status'] = 'idle'
  const settle = (text = 'Answer', reason: TurnEndReason = { kind: 'completed' }): void => {
    if (activity === undefined) return
    if (text !== '') session.append('assistant/message', {
      turn, step: 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason })
    status = 'idle'
    activity.resolve(undefined)
    activity = undefined
  }
  const followup = vi.fn<Agent['followup']>((message) => {
    activity = Promise.withResolvers<undefined>()
    status = 'running'
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    session.append('turn/start', { turn: ++turn })
    started.resolve(undefined)
    if (!options.manual) settle()
  })
  const whenIdle = vi.fn<Agent['whenIdle']>(() => activity?.promise ?? Promise.resolve(undefined))
  const cancel = vi.fn<Agent['cancel']>(() => {
    cancelled.resolve(undefined)
    if (!options.manualDrain) settle('', { kind: 'aborted', reason: { kind: 'user' } })
  })
  const unsupported = (): never => { throw new Error('Unsupported test Agent capability') }
  const agent: Agent = {
    id: session.id, session, ctx, options: {}, model: { current: () => undefined, select: () => {} } as never, followup, whenIdle, cancel,
    get status() { return status },
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported,
      prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported },
    send: unsupported, steer: unsupported, inject: unsupported, runMaintenance: unsupported,
  }
  const receipts = new Map<string, 'reserved' | 'committed'>()
  const commitEffect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const admissions: {
    value: WecomAdmission
    commit: Mock<WecomAdmission['commit']>
    release: Mock<WecomAdmission['release']>
    released: PromiseWithResolvers<undefined>
  }[] = []
  const admit = vi.fn<(conversation: string, delivery: string, signal: AbortSignal) => Promise<WecomAdmission | null>>(
    async (_conversation, delivery, signal) => {
      signal.throwIfAborted()
      if (receipts.has(delivery)) return null
      receipts.set(delivery, 'reserved')
      const released = Promise.withResolvers<undefined>()
      const commit = vi.fn(async () => {
        receipts.set(delivery, 'committed')
        await commitEffect()
      })
      const release = vi.fn(() => {
        if (receipts.get(delivery) === 'reserved') receipts.delete(delivery)
        released.resolve(undefined)
      })
      const value: WecomAdmission = { agent, commit, release }
      admissions.push({ value, commit, release, released })
      return value
    },
  )
  const changed = vi.fn<(status: WecomSnapshot['bindings'][number]['status']) => void>()
  const channelConfig: Config = Object.assign({}, config, options.config)
  const channel = new WecomChannel(ctx, channelConfig, binding, 'private-secret', admit, changed)
  const socket = sdk.instances.at(-1)!
  cleanups.push(async () => {
    settle('', { kind: 'aborted', reason: { kind: 'user' } })
    await channel.close()
    await ctx.fiber.dispose()
  })
  const released = async (index = 0): Promise<void> => {
    await vi.waitFor(() => { expect(admissions.length).toBeGreaterThan(index) })
    await admissions[index]!.released.promise
  }
  return { channel, socket, agent, session, followup, whenIdle, cancel, settle,
    started, cancelled, admit, admissions, receipts, commitEffect, changed, warn, released }
}

beforeEach(() => { sdk.instances.length = 0 })
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WecomChannel admission and replies', () => {
  it('publishes online only after SDK authentication and sanitizes connection failures', async () => {
    const h = fixture()
    h.channel.start()
    expect(h.socket.options).toMatchObject({ botId: 'robot', secret: 'private-secret', wsUrl: config.wsUrl,
      requestTimeout: config.responseTimeoutMs, scene: 1 })
    expect(h.socket.connect).toHaveBeenCalledOnce()
    h.socket.emit('connected')
    expect(h.changed.mock.calls).toEqual([['connecting']])
    h.socket.emit('authenticated')
    h.socket.emit('disconnected', 'private-secret')
    h.socket.emit('reconnecting', 1)
    h.socket.emit('error', new Error('private-secret'))
    expect(h.changed.mock.calls).toEqual([['connecting'], ['online'], ['offline'], ['connecting'], ['offline']])
    expect(h.warn.mock.calls.flat().join(' ')).not.toContain('private-secret')
    const logger = h.socket.options.logger!
    logger.debug('secret'); logger.info('secret'); logger.warn('secret'); logger.error('secret')
    await h.channel.close()
    h.channel.start()
    h.socket.emit('authenticated')
    expect(h.socket.connect).toHaveBeenCalledOnce()
    expect(h.socket.eventNames()).toEqual([])
  })

  it('commits only after followup enqueues and before waiting for the owned interval', async () => {
    const h = fixture({ manual: true })
    const commitGate = Promise.withResolvers<undefined>()
    h.commitEffect.mockReturnValueOnce(commitGate.promise)
    h.socket.emit('message.text', frame())
    await h.started.promise
    await vi.waitFor(() => { expect(h.admissions[0]!.commit).toHaveBeenCalledOnce() })
    const admission = h.admissions[0]!
    expect(h.receipts.get('message')).toBe('committed')
    expect(h.whenIdle).toHaveBeenCalledOnce()
    expect(h.followup.mock.invocationCallOrder[0]).toBeLessThan(admission.commit.mock.invocationCallOrder[0]!)
    expect(h.followup.mock.calls[0]![0]).toMatchObject({ role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Hello' }] })
    expect(admission.release).not.toHaveBeenCalled()
    commitGate.resolve(undefined)
    await vi.waitFor(() => { expect(h.whenIdle).toHaveBeenCalledTimes(2) })
    expect(admission.commit.mock.invocationCallOrder[0]).toBeLessThan(h.whenIdle.mock.invocationCallOrder[1]!)
    h.settle('Final reply')
    await h.released()
    expect(h.socket.replyStream.mock.calls.map(call => [call[2], call[3]])).toEqual([
      ['正在处理…', false], ['Final reply', true],
    ])
    const [initial, final] = h.socket.replyStream.mock.calls
    expect(final![0]).toBe(initial![0])
    expect(final![1]).toBe(initial![1])
    expect(admission.release).toHaveBeenCalledOnce()
    expect(h.admit.mock.calls[0]!.slice(0, 2)).toEqual(['["single","user"]', 'message'])
  })

  it('leaves deduplication to admission and suppresses duplicate followups and replies', async () => {
    const h = fixture()
    h.socket.emit('message', frame())
    h.socket.emit('message.text', frame())
    h.socket.emit('message.text', frame())
    await h.released()
    await vi.waitFor(() => { expect(h.admit).toHaveBeenCalledTimes(2) })
    await h.channel.close()
    expect(h.admissions).toHaveLength(1)
    expect(h.followup).toHaveBeenCalledOnce()
    expect(h.admissions[0]!.commit).toHaveBeenCalledOnce()
    expect(h.socket.replyStream).toHaveBeenCalledTimes(2)
  })

  it('releases a failed acknowledgement without followup or commit, allowing redelivery', async () => {
    const h = fixture()
    h.socket.replyStream.mockRejectedValueOnce(new Error('ACK failed with private-secret'))
    h.socket.emit('message.text', frame())
    await h.released()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.admissions[0]!.commit).not.toHaveBeenCalled()
    expect(h.admissions[0]!.release).toHaveBeenCalledOnce()
    expect(h.receipts.has('message')).toBe(false)
    expect(h.socket.replyStream.mock.lastCall![2]).toBe('消息未提交，请稍后重新发送')
    h.socket.emit('message.text', frame())
    await h.released(1)
    expect(h.followup).toHaveBeenCalledOnce()
    expect(h.admissions[1]!.commit).toHaveBeenCalledOnce()
    expect(h.warn.mock.calls.flat().join(' ')).not.toContain('private-secret')
  })

  it('releases a synchronous followup failure without committing', async () => {
    const h = fixture()
    h.followup.mockImplementationOnce(() => { throw new Error('enqueue failed') })
    h.socket.emit('message.text', frame())
    await h.released()
    expect(h.admissions[0]!.commit).not.toHaveBeenCalled()
    expect(h.receipts.size).toBe(0)
    expect(h.agent.status).toBe('idle')
    expect(h.cancel).toHaveBeenCalled()
  })

  it('retains dedup protection and drains an enqueued turn when receipt persistence fails', async () => {
    const h = fixture({ manual: true })
    h.commitEffect.mockRejectedValueOnce(new Error('receipt persistence failed'))
    h.socket.emit('message.text', frame())
    await h.released()
    expect(h.cancel).toHaveBeenCalled()
    expect(h.agent.status).toBe('idle')
    expect(h.socket.replyStream.mock.lastCall![2]).toContain('不要重复执行操作')
    expect(h.receipts.get('message')).toBe('committed')
    h.socket.emit('message.text', frame())
    await vi.waitFor(() => { expect(h.admit).toHaveBeenCalledTimes(2) })
    expect(h.followup).toHaveBeenCalledOnce()
  })

  it('reports final-reply uncertainty without replaying an already committed delivery', async () => {
    const h = fixture()
    h.socket.replyStream.mockResolvedValueOnce({ headers: { req_id: 'ack' }, errcode: 0 })
      .mockRejectedValueOnce(new Error('reply delivery unknown'))
    h.socket.emit('message.text', frame())
    await h.released()
    expect(h.socket.replyStream.mock.lastCall![2]).toContain('回复送达情况不确定')
    expect(h.warn.mock.calls.flat().join(' ')).toContain('do not repeat operations')
    h.socket.emit('message.text', frame())
    await vi.waitFor(() => { expect(h.admit).toHaveBeenCalledTimes(2) })
    expect(h.followup).toHaveBeenCalledOnce()
    expect(h.socket.replyStream).toHaveBeenCalledTimes(3)
  })

  it('contains a failed error reply and continues the robot queue', async () => {
    const h = fixture()
    h.socket.replyStream.mockRejectedValueOnce(new Error('ACK failed')).mockRejectedValueOnce(new Error('error reply failed'))
    h.socket.emit('message.text', frame('first'))
    h.socket.emit('message.text', frame('second'))
    await h.released(1)
    expect(h.followup).toHaveBeenCalledOnce()
    expect(h.admissions[0]!.commit).not.toHaveBeenCalled()
    expect(h.admissions[1]!.commit).toHaveBeenCalledOnce()
    expect(h.warn.mock.calls.flat().join(' ')).toContain('WeCom conversation failed')
  })

  it.each<TurnEndReason>([{ kind: 'blocked' }, { kind: 'aborted', reason: { kind: 'user' } }])(
    'reports uncertainty for a non-completed turn ($kind)', async (reason) => {
      const h = fixture({ manual: true })
      h.socket.emit('message.text', frame())
      await h.started.promise
      h.settle('Partial answer', reason)
      await h.released()
      expect(h.socket.replyStream.mock.lastCall![2]).toContain('不要重复执行操作')
      expect(h.receipts.get('message')).toBe('committed')
    },
  )

  it('does not use output from before admission and reports an empty interval', async () => {
    const h = fixture({ manual: true })
    h.session.append('assistant/message', { turn: 0, step: 0, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Old answer' }],
    }) }, { surfaceOp: 'append' })
    h.socket.emit('message.text', frame())
    await h.started.promise
    h.settle('')
    await h.released()
    expect(h.socket.replyStream.mock.lastCall![2]).toBe('智能体未返回文字内容，请换一种方式提问')
  })

  it('includes assistant text but does not expose reasoning in the reply', async () => {
    const h = fixture({ manual: true })
    h.socket.emit('message.text', frame())
    await h.started.promise
    h.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [
        { type: 'reasoning', text: 'Private reasoning' },
        { type: 'text', text: 'Visible answer' },
        { type: 'text', text: 'Next paragraph' },
      ],
    }) }, { surfaceOp: 'append' })
    h.settle('')
    await h.released()
    expect(h.socket.replyStream.mock.lastCall![2]).toBe('Visible answer\nNext paragraph')
  })

  it('reports an interval without a turn settlement as uncertain', async () => {
    const h = fixture()
    h.followup.mockImplementationOnce(() => {})
    h.socket.emit('message.text', frame())
    await h.released()
    expect(h.socket.replyStream.mock.lastCall![2]).toContain('不要重复执行操作')
    expect(h.admissions[0]!.commit).toHaveBeenCalledOnce()
  })
})

describe('WecomChannel cancellation and quiescence', () => {
  it('times out an owned turn, cancels it, and waits for settlement before continuing', async () => {
    vi.useFakeTimers()
    const h = fixture({ manual: true, manualDrain: true })
    h.socket.emit('message.text', frame('first'))
    h.socket.emit('message.text', frame('second'))
    await h.started.promise
    await vi.advanceTimersByTimeAsync(config.responseTimeoutMs)
    await h.cancelled.promise
    expect(h.agent.status).toBe('running')
    expect(h.admit).toHaveBeenCalledOnce()
    expect(h.admissions[0]!.release).not.toHaveBeenCalled()
    h.settle('', { kind: 'aborted', reason: { kind: 'user' } })
    await h.admissions[0]!.released.promise
    await vi.waitFor(() => { expect(h.followup).toHaveBeenCalledTimes(2) })
    h.settle('Second answer')
    await h.released(1)
    expect(h.agent.status).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('interrupts a timeout wait for prior activity without cancelling work it did not enqueue', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const prior = Promise.withResolvers<undefined>()
    const waiting = Promise.withResolvers<undefined>()
    h.whenIdle.mockImplementationOnce(() => { waiting.resolve(undefined); return prior.promise })
    h.socket.emit('message.text', frame())
    await waiting.promise
    await vi.advanceTimersByTimeAsync(config.responseTimeoutMs)
    await h.admissions[0]!.released.promise
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.admissions[0]!.commit).not.toHaveBeenCalled()
    expect(h.receipts.size).toBe(0)
    prior.resolve(undefined)
    await h.channel.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('commits an enqueued message even when timeout fires synchronously during followup', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const enqueue = h.followup.getMockImplementation()!
    h.followup.mockImplementationOnce((message) => {
      vi.advanceTimersByTime(config.responseTimeoutMs)
      enqueue(message)
    })
    h.socket.emit('message.text', frame())
    await h.released()
    expect(h.admissions[0]!.commit).toHaveBeenCalledOnce()
    expect(h.receipts.get('message')).toBe('committed')
    expect(h.agent.status).toBe('idle')
  })

  it('close cancels and drains owned work before disconnecting and skips queued messages', async () => {
    const h = fixture({ manual: true, manualDrain: true })
    h.socket.emit('message.text', frame('first'))
    h.socket.emit('message.text', frame('second'))
    await h.started.promise
    const closed = h.channel.close()
    await h.cancelled.promise
    expect(h.socket.disconnect).not.toHaveBeenCalled()
    expect(h.admissions[0]!.release).not.toHaveBeenCalled()
    h.socket.emit('message.text', frame('after-close'))
    h.socket.emit('authenticated')
    expect(h.changed).not.toHaveBeenCalled()
    h.settle('', { kind: 'aborted', reason: { kind: 'user' } })
    await closed
    expect(h.agent.status).toBe('idle')
    expect(h.admit).toHaveBeenCalledOnce()
    expect(h.socket.replyStream).toHaveBeenCalledOnce()
    expect(h.socket.disconnect).toHaveBeenCalledOnce()
    expect(h.admissions[0]!.release).toHaveBeenCalledOnce()
  })

  it('close drains an in-flight final reply before disconnecting', async () => {
    const h = fixture()
    const reply = Promise.withResolvers<WsFrame>()
    const replying = Promise.withResolvers<undefined>()
    h.socket.replyStream.mockResolvedValueOnce({ headers: { req_id: 'ack' } }).mockImplementationOnce(() => {
      replying.resolve(undefined)
      return reply.promise
    })
    h.socket.emit('message.text', frame())
    await replying.promise
    const closed = h.channel.close()
    expect(h.socket.disconnect).not.toHaveBeenCalled()
    expect(h.admissions[0]!.release).not.toHaveBeenCalled()
    reply.resolve({ headers: { req_id: 'ack-final' } })
    await closed
    expect(h.socket.disconnect).toHaveBeenCalledOnce()
    expect(h.admissions[0]!.release).toHaveBeenCalledOnce()
  })

  it('close drains an acknowledgement and releases without followup when it arrives after cancellation', async () => {
    const h = fixture()
    const ack = Promise.withResolvers<WsFrame>()
    const replying = Promise.withResolvers<undefined>()
    h.socket.replyStream.mockImplementationOnce(() => { replying.resolve(undefined); return ack.promise })
    h.socket.emit('message.text', frame())
    await replying.promise
    const closed = h.channel.close()
    expect(h.socket.disconnect).not.toHaveBeenCalled()
    ack.resolve({ headers: { req_id: 'ack' } })
    await closed
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.admissions[0]!.commit).not.toHaveBeenCalled()
    expect(h.receipts.size).toBe(0)
  })

  it('close releases a reservation returned by admission after cancellation', async () => {
    const h = fixture()
    const admitted = Promise.withResolvers<WecomAdmission | null>()
    const admitting = Promise.withResolvers<undefined>()
    const release = vi.fn()
    const commit = vi.fn<WecomAdmission['commit']>().mockResolvedValue(undefined)
    h.admit.mockImplementationOnce(() => { admitting.resolve(undefined); return admitted.promise })
    h.socket.emit('message.text', frame())
    await admitting.promise
    const closed = h.channel.close()
    expect(h.socket.disconnect).not.toHaveBeenCalled()
    admitted.resolve({ agent: h.agent, commit, release })
    await closed
    expect(release).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.socket.replyStream).not.toHaveBeenCalled()
  })
})

describe('WecomChannel validation and bounds', () => {
  it.each([
    { msgid: '' }, { aibotid: 'other-robot' }, { chattype: 'group' as const },
    { text: { content: '' } }, { from: { userid: '' } },
  ])('discards invalid or mismatched incoming messages (%j)', async (body) => {
    const h = fixture()
    h.socket.emit('message.text', frame('invalid', body))
    await vi.waitFor(() => { expect(h.warn).toHaveBeenCalled() })
    expect(h.admit).not.toHaveBeenCalled()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.socket.replyStream).not.toHaveBeenCalled()
  })

  it('rejects oversized input before reserving a receipt', async () => {
    const h = fixture({ config: { maxInputChars: 1 } })
    h.socket.emit('message.text', frame())
    await vi.waitFor(() => { expect(h.socket.replyStream).toHaveBeenCalledOnce() })
    expect(h.admit).not.toHaveBeenCalled()
    expect(h.socket.replyStream.mock.lastCall!.slice(2, 4)).toEqual(['消息过长，请缩短后重试', true])
  })

  it('routes group conversations by chat id instead of sender', async () => {
    const h = fixture()
    h.socket.emit('message.text', frame('group-message', { chattype: 'group', chatid: 'chat' }))
    await h.released()
    expect(h.admit.mock.calls[0]!.slice(0, 2)).toEqual(['["group","chat"]', 'group-message'])
  })

  it('bounds multibyte assistant output including its notice', async () => {
    const h = fixture({ manual: true })
    h.socket.emit('message.text', frame())
    await h.started.promise
    h.settle('文字😀'.repeat(100))
    await h.released()
    const text = h.socket.replyStream.mock.lastCall![2]
    expect(text).toMatch(/\n\[内容过长，已截断\]$/)
    expect(text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(config.maxReplyBytes)
    expect(h.socket.replyStream.mock.calls.every(call => Buffer.byteLength(call[2]) <= config.maxReplyBytes)).toBe(true)
  })

  it('bounds the robot queue and serializes distinct messages', async () => {
    const h = fixture({ manual: true, config: { maxQueuedMessages: 2 } })
    h.socket.emit('message.text', frame('first'))
    h.socket.emit('message.text', frame('second'))
    h.socket.emit('message.text', frame('overflow'))
    await h.started.promise
    expect(h.admit).toHaveBeenCalledOnce()
    expect(h.warn.mock.calls.flat().join(' ')).toContain('queue is full')
    h.settle('First')
    await h.released()
    await vi.waitFor(() => { expect(h.followup).toHaveBeenCalledTimes(2) })
    h.settle('Second')
    await h.released(1)
    expect(h.admit.mock.calls.map(call => call[1])).toEqual(['first', 'second'])
    expect(h.socket.replyStream.mock.calls.filter(call => call[3]).map(call => call[2])).toEqual(['First', 'Second'])
  })

  it('does not block another robot while one robot is running', async () => {
    const first = fixture({ manual: true })
    const second = fixture()
    first.socket.emit('message.text', frame())
    await first.started.promise
    second.socket.emit('message.text', frame())
    await second.released()
    expect(first.admissions[0]!.release).not.toHaveBeenCalled()
    expect(second.socket.replyStream.mock.lastCall![2]).toBe('Answer')
    first.settle()
    await first.released()
  })

  it('serializes and drains unsupported replies, dropping queued replies on close', async () => {
    const h = fixture({ config: { maxQueuedMessages: 2 } })
    const reply = Promise.withResolvers<WsFrame>()
    const replying = Promise.withResolvers<undefined>()
    h.socket.replyStream.mockImplementationOnce(() => { replying.resolve(undefined); return reply.promise })
    const image = { ...frame(), body: { ...frame().body!, msgtype: 'image' } }
    h.socket.emit('message', image)
    await replying.promise
    h.socket.emit('message', image)
    h.socket.emit('message', image)
    const closed = h.channel.close()
    expect(h.socket.disconnect).not.toHaveBeenCalled()
    reply.resolve({ headers: { req_id: 'ack' } })
    await closed
    expect(h.socket.replyStream).toHaveBeenCalledOnce()
    expect(h.socket.replyStream.mock.lastCall![2]).toContain('仅支持文字消息')
    expect(h.admit).not.toHaveBeenCalled()
  })

  it('contains unsupported reply failures and ignores messages after close', async () => {
    const h = fixture()
    h.socket.replyStream.mockRejectedValueOnce(new Error('reply failed'))
    const image = { ...frame(), body: { ...frame().body!, msgtype: 'image' } }
    h.socket.emit('message', image)
    await vi.waitFor(() => { expect(h.warn.mock.calls.flat().join(' ')).toContain('reply could not be delivered') })
    await h.channel.close()
    h.socket.emit('message', image)
    expect(h.socket.replyStream).toHaveBeenCalledOnce()
  })
})

describe('boundedReply and routingHash', () => {
  it('keeps exact byte limits and whole UTF-8 characters', () => {
    const exact = '字'.repeat(42) + 'ab'
    expect(Buffer.byteLength(exact)).toBe(128)
    expect(boundedReply(exact, 128)).toBe(exact)
    const suffix = '\n[内容过长，已截断]'
    const room = 128 - Buffer.byteLength(suffix)
    expect(boundedReply('😀'.repeat(100), 128)).toBe('😀'.repeat(Math.floor(room / 4)) + suffix)
    expect(boundedReply('字'.repeat(100), Buffer.byteLength(suffix))).toBe(suffix)
    expect(boundedReply('', 128)).toBe('')
  })

  it('hashes exact routing tuples without exposing identifiers or delimiter collisions', () => {
    expect(routingHash('robot', 'user')).toMatch(/^[a-f0-9]{64}$/)
    expect(routingHash('robot', 'user')).toBe(routingHash('robot', 'user'))
    expect(routingHash('robot', 'user')).not.toBe(routingHash('user', 'robot'))
    expect(routingHash('a', 'b:c')).not.toBe(routingHash('a:b', 'c'))
  })
})
