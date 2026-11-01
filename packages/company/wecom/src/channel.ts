/** Official long-connection transport and serialized text delivery. */
import { createHash, randomUUID } from 'node:crypto'
import { WSClient, type TextMessage, type WsFrame } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config } from './config.ts'
import type { WecomBinding, WecomSnapshot } from './types.ts'

type Status = WecomSnapshot['bindings'][number]['status']

/** Main-service reservation for one delivery; null admission denotes a duplicate. */
export interface WecomAdmission {
  /** The conversation's Agent, retained by the main service until channel close drains. */
  agent: Agent
  /**
   * Retain duplicate suppression and persist the receipt after followup enqueues, before awaiting idle.
   * A rejected persistence write must retain duplicate suppression: the message is already queued.
   * @returns completion of receipt persistence.
   */
  commit(): Promise<void>
  /** Release an unused reservation; after commit is invoked, preserve duplicate suppression. */
  release(): void | Promise<void>
}

const inbound = z.object({ msgid: z.string().min(1).max(512), aibotid: z.string(),
  chattype: z.enum(['single', 'group']), chatid: z.string().min(1).optional(),
  from: z.object({ userid: z.string().min(1) }), text: z.object({ content: z.string().min(1) }),
}).refine(value => value.chattype === 'single' || value.chatid !== undefined)

/** Bound UTF-8 text without splitting a character or omitting the truncation marker.
 * @param text - assembled assistant text.
 * @param maxBytes - complete payload ceiling, at least the UTF-8 size of the truncation notice.
 * @returns a protocol-sized reply.
 */
export function boundedReply(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const suffix = '\n[内容过长，已截断]'
  let result = ''
  let bytes = Buffer.byteLength(suffix)
  for (const character of text) {
    bytes += Buffer.byteLength(character)
    if (bytes > maxBytes) break
    result += character
  }
  return result + suffix
}

/** One robot's connection owns callbacks, queue, cancellation and quiescence. */
export class WecomChannel {
  private readonly socket: WSClient
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - live Agent access and default-enabled diagnostics.
   * @param config - connection and message bounds.
   * @param binding - immutable agent routing for this robot.
   * @param secret - credential value resolved for this connection only.
   * @param admit - reserve delivery and resolve its durable Session; duplicates return null. Honor cancellation before returning.
   * @param changed - publish sanitized connection state.
   */
  constructor(private readonly ctx: Context, private readonly config: Config, private readonly binding: WecomBinding,
    secret: string, private readonly admit: (conversation: string, delivery: string, signal: AbortSignal) => Promise<WecomAdmission | null>,
    private readonly changed: (status: Status) => void) {
    this.socket = new WSClient({ botId: binding.botId, secret, wsUrl: config.wsUrl, scene: 1,
      requestTimeout: config.responseTimeoutMs,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } })
    const publish = (status: Status): void => { if (!this.lifetime.signal.aborted) changed(status) }
    this.socket.on('authenticated', () => { publish('online') })
    this.socket.on('disconnected', () => { publish('offline') })
    this.socket.on('reconnecting', () => { publish('connecting') })
    this.socket.on('error', () => {
      publish('offline')
      ctx.logger.warn('WeCom robot connection failed; check robot credentials and outbound connectivity')
    })
    this.socket.on('message.text', (frame) => { this.enqueue(frame) })
    this.socket.on('message', (frame) => {
      if (frame.body?.msgtype === 'text') return
      this.enqueueReply(frame, '当前智能体仅支持文字消息，请用文字描述你的问题')
    })
  }

  /** Start authentication; online state requires the official acknowledgement. */
  start(): void {
    if (this.lifetime.signal.aborted) return
    this.changed('connecting')
    this.socket.connect()
  }

  /** Stop admission and cancel owned turns; retain the SDK until turns and replies settle.
   * @returns completion of queued callbacks and connection teardown.
   */
  async close(): Promise<void> {
    this.lifetime.abort()
    await this.tail
    try { this.socket.disconnect() } finally { this.socket.removeAllListeners() }
  }

  private enqueueReply(frame: WsFrame<unknown>, text: string): void {
    if (this.lifetime.signal.aborted || this.pending >= this.config.maxQueuedMessages) return
    this.pending++
    this.tail = this.tail.then(async () => {
      if (!this.lifetime.signal.aborted) {
        await this.socket.replyStream(frame, randomUUID(), boundedReply(text, this.config.maxReplyBytes), true)
      }
    }).catch(() => { this.ctx.logger.warn('WeCom reply could not be delivered') })
      .finally(() => { this.pending-- })
  }

  private enqueue(frame: WsFrame<TextMessage>): void {
    if (this.lifetime.signal.aborted) return
    if (this.pending >= this.config.maxQueuedMessages) {
      this.ctx.logger.warn('WeCom message queue is full; incoming message was not accepted')
      return
    }
    this.pending++
    this.tail = this.tail.then(() => this.deliver(frame)).catch(() => {
      this.ctx.logger.warn('WeCom conversation failed; inspect the corresponding Harness Session')
    }).finally(() => { this.pending-- })
  }

  private async deliver(frame: WsFrame<TextMessage>): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const parsed = inbound.safeParse(frame.body)
    if (!parsed.success || parsed.data.aibotid !== this.binding.botId) {
      this.ctx.logger.warn('WeCom discarded an invalid or mismatched incoming message')
      return
    }
    const body = parsed.data
    const streamId = randomUUID()
    if (body.text.content.length > this.config.maxInputChars) {
      await this.socket.replyStream(frame, streamId, boundedReply('消息过长，请缩短后重试', this.config.maxReplyBytes), true)
      return
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => {
      timeout.abort(new DOMException('WeCom response timed out', 'TimeoutError'))
    }, this.config.responseTimeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, timeout.signal])
    let admission: WecomAdmission | null = null
    let owned = false
    let enqueued = false
    const cancel = (): void => { if (owned) admission?.agent.cancel({ kind: 'user' }) }
    try {
      const conversation = JSON.stringify([body.chattype, body.chattype === 'group' ? body.chatid : body.from.userid])
      admission = await this.admit(conversation, body.msgid, signal)
      if (admission === null) return
      signal.throwIfAborted()
      await this.socket.replyStream(frame, streamId, boundedReply('正在处理…', this.config.maxReplyBytes), false)
      signal.throwIfAborted()
      const { agent } = admission
      await this.waitForIdle(agent, signal)
      signal.throwIfAborted()
      // Output covers this idle-to-idle interval, not a per-message result promised by followup.
      const offset = agent.session.seq
      owned = true
      signal.addEventListener('abort', cancel, { once: true })
      const messageInput: UserMessage = Object.freeze({ id: brandString<MessageId>(randomUUID()), role: 'user',
        source: Object.freeze({ kind: 'user' }), content: Object.freeze([Object.freeze({ type: 'text', text: body.text.content })]) })
      agent.followup(messageInput)
      enqueued = true
      const committed = admission.commit()
      if (signal.aborted) cancel()
      await committed
      // Cancellation requests a stop; whenIdle must still drain tools and turn settlement.
      await agent.whenIdle()
      signal.throwIfAborted()
      // oxlint-disable-next-line typescript/no-deprecated -- Existing interval output selection retains the synchronous Session reader.
      const events = agent.session.snapshotEvents(offset)
      const terminal = events.findLast(event => event.type === 'turn/end')
      if (terminal?.type !== 'turn/end' || terminal.data.reason.kind !== 'completed') throw new Error('WeCom turn did not complete')
      const message = events.findLast(event => event.type === 'assistant/message')
      const text = message?.type === 'assistant/message'
        ? message.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : ''
      await this.socket.replyStream(frame, streamId, boundedReply(text || '智能体未返回文字内容，请换一种方式提问', this.config.maxReplyBytes), true)
    } catch (error) {
      cancel()
      if (owned && admission !== null) await admission.agent.whenIdle()
      const uncertain = enqueued || (error instanceof RemoteError && error.code === 'wecom/delivery-uncertain')
      // Session events retain failures; diagnostics exclude credentials and business payloads.
      this.ctx.logger.warn(uncertain
        ? 'WeCom delivery submission, result or reply is uncertain; do not repeat operations; inspect the Harness Session'
        : 'WeCom message was not enqueued; retry delivery after checking robot connectivity')
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- close can abort the lifetime during an awaited operation.
      if (!this.lifetime.signal.aborted) {
        const text = uncertain
          ? '消息提交、处理或回复送达情况不确定；不要重复执行操作，请检查会话记录'
          : '消息未提交，请稍后重新发送'
        await this.socket.replyStream(frame, streamId, boundedReply(text, this.config.maxReplyBytes), true)
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      await admission?.release()
    }
  }

  /** Wait for prior activity without claiming or cancelling that activity. */
  private async waitForIdle(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(new DOMException('WeCom idle wait cancelled', 'AbortError')) }
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      await Promise.race([agent.whenIdle(), aborted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

/** Hash provider-owned routing identifiers before using them as storage keys.
 * @param parts - robot and conversation or delivery identifiers.
 * @returns a stable lowercase hash.
 */
export function routingHash(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
