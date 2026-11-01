/** Scan-to-create robot publication and durable Cloud Agent routing. */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { z } from 'zod'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WecomAdmission } from './channel.ts'
import type { CloudAgentId, CloudAgentOwnerId, CloudAgentReleaseId } from '@deepseek-ai/dsh-company-cloud-agent/types'
import type {} from '@deepseek-ai/dsh-company-cloud-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { Config } from './config.ts'
import { WecomChannel, routingHash } from './channel.ts'
import { wecomDomain } from './storage.ts'
import type { WecomAuthorization, WecomBinding, WecomBindingId, WecomConversationId, WecomRequest, WecomRequestId, WecomSnapshot } from './types.ts'

export { Config } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Company-owned WeCom authorization and robot connections. */
    companyWecom: CompanyWecomService
  }
}

const authorization = z.object({
  requestId: z.uuid(), botId: z.string().trim().min(1).max(256), secret: z.string().min(1).max(4096),
}).strict()

/** Owns robot credentials by reference, immutable publication bindings and connection teardown. */
export class CompanyWecomService extends TypertRemoteService {
  static inject = ['cloudAgents', 'agents', 'sessionController', 'credentials', 'storageDomain']
  static Config = Config
  private readonly owner: Context
  private readonly config: Config
  private readonly ready: Promise<Domain<typeof wecomDomain>>
  private readonly initialized: Promise<void>
  private readonly channels = new Map<WecomBindingId, WecomChannel>()
  private readonly statuses = new Map<WecomBindingId, WecomSnapshot['bindings'][number]['status']>()
  private readonly subscribers = new Set<() => void>()
  private chain: Promise<void> = Promise.resolve()
  private admissions: Promise<void> = Promise.resolve()
  private readonly submitted = new Set<string>()
  private stopping = false

  /**
   * @param ctx - Cloud Agent, credential and durable-domain owners.
   * @param config - validated connection settings and bounds.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'companyWecom', { namespace: 'companyWecom' })
    this.owner = ctx
    this.config = Config(config)
    this.ready = ctx.storageDomain.open(wecomDomain)
    this.initialized = this.restore()
    ctx.effect(() => () => this.close(), 'wecom: connections, callbacks and domain')
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-company-wecom/publish-wecom'),
        name: '发布企微', aliases: ['publish-wecom'], description: '将当前已发布智能体版本接入企微机器人',
        handler: ({ agent, signal }) => this.owner.agents.withInitiator(agent, async () => {
          signal.throwIfAborted()
          const catalog = await this.owner.cloudAgents.catalog()
          const conversation = catalog.conversations.find(item => item.sessionId === agent.id)
          const record = conversation?.role === 'authoring' && conversation.agentId !== null
            ? catalog.mine.find(item => item.id === conversation.agentId) : undefined
          const releaseId = record?.publishedReleaseId ?? null
          if (record === undefined || releaseId === null) {
            return { kind: 'error', text: '请先在当前智能体对话中保存并发布一个版本，再执行 /发布企微。' }
          }
          const request = await this.requestRelease(record.id, releaseId)
          return { kind: 'success', text: `已创建「${request.name}」的企微扫码授权请求，请在企微机器人页面点击扫码。` }
        }),
      })
    })
  }

  /** Restore durable connections without blocking application readiness on the external gateway. */
  async [Service.init](): Promise<void> { await this.initialized }

  private async restore(): Promise<void> {
    const domain = await this.ready
    if ([...domain.table('receipts').entries()].some(([, receipt]) => receipt.state === 'pending')) {
      this.owner.logger.warn('WeCom has interrupted deliveries with unknown submission state; they will not replay automatically. Inspect Harness Sessions before repeating operations')
    }
    for (const [id, binding] of domain.table('bindings').entries()) {
      if (id !== binding.id) throw new Error('WeCom binding key differs from stored identity')
      if (binding.enabled) await this.connect(binding)
    }
  }

  private ownerId(): CloudAgentOwnerId {
    const authentication = this.ctx.get('companyWecomAuth')
    if (authentication !== undefined) return brandString<CloudAgentOwnerId>(authentication.ownerScope())
    const invocation = this.ctx.invocation
    if (invocation !== undefined && invocation.peer.principal.kind !== 'owner') {
      throw new RemoteError('wecom/owner-required', 'A verified company member is required to manage WeCom robots', {})
    }
    return brandString<CloudAgentOwnerId>('local-owner')
  }

  /** Read sanitized requests and actual connection state.
   * @returns robot bindings without Secret values or conversation contents.
   */
  @Remote
  async snapshot(): Promise<WecomSnapshot> {
    const ownerId = this.ownerId()
    const domain = await this.ready
    const bindings = [...domain.table('bindings').entries()].map(([, value]) => value).filter(value => value.ownerId === ownerId)
    return { source: this.config.source,
      requests: [...domain.table('requests').entries()].filter(([, value]) => value.ownerId === ownerId).map(([, value]) => ({ ...value,
        bindingId: bindings.find(binding => binding.requestId === value.id)?.id ?? null })),
      bindings: bindings.map(binding => ({ ...binding,
        status: binding.enabled ? this.statuses.get(binding.id) ?? 'offline' : 'disabled' })),
    }
  }

  /** Follow sanitized publication and connection state, coalescing slow readers.
   * @param signal - stream cancellation.
   * @returns initial snapshot and subsequent committed updates.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WecomSnapshot> {
    this.ownerId()
    const ended = (): boolean => signal.aborted || this.stopping
    let changed = true
    let wake = Promise.withResolvers<void>()
    const notify = (): void => { changed = true; wake.resolve() }
    this.subscribers.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!ended()) {
        if (!changed) await wake.promise
        if (ended()) return
        changed = false
        wake = Promise.withResolvers<void>()
        yield await this.snapshot()
      }
    } finally { this.subscribers.delete(notify); signal.removeEventListener('abort', notify) }
  }

  /** Save credentials returned by the official authorization window and bind the exact requested release.
   * @param input - one pending request and newly authorized robot credentials; never logged.
   * @returns binding identity; online state follows only after the gateway authenticates.
   */
  @Remote
  complete(input: WecomAuthorization): Promise<WecomBinding> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const parsed = authorization.safeParse(input)
      if (!parsed.success) throw new RemoteError('wecom/invalid-authorization', 'Invalid robot authorization', {})
      const domain = await this.ready
      const request = domain.table('requests').get(brandString<WecomRequestId>(parsed.data.requestId))
      if (request === undefined || request.expiresAt <= Date.now()) throw new RemoteError('wecom/expired', 'Authorization expired; request publication again', {})
      if (request.ownerId !== ownerId) throw new RemoteError('wecom/owner-required', 'This authorization belongs to another member', {})
      const bindings = [...domain.table('bindings').entries()].map(([, value]) => value).filter(value => value.ownerId === ownerId)
      const completed = bindings.find(binding => binding.requestId === request.id)
      if (completed !== undefined) return completed
      const record = (await this.owner.cloudAgents.catalog()).mine.find(entry => entry.id === request.agentId)
      if (!record?.releases.some(release => release.id === request.releaseId && release.kind === 'published')) {
        throw new RemoteError('wecom/release-changed', 'The requested saved release is unavailable', {})
      }
      const id = brandString<WecomBindingId>(routingHash(parsed.data.botId))
      const previous = domain.table('bindings').get(id)
      if (previous !== undefined && (previous.agentId !== request.agentId || previous.releaseId !== request.releaseId)) {
        throw new RemoteError('wecom/already-bound', 'This robot is already bound to another version; create another robot', {})
      }
      if (previous === undefined && bindings.length >= this.config.maxBindings) {
        throw new RemoteError('wecom/limit', 'Robot limit reached; increase the configured limit before retrying', {})
      }
      const binding: WecomBinding = { id, ownerId, botId: parsed.data.botId, agentId: request.agentId,
        releaseId: request.releaseId, name: request.name, enabled: true, requestId: request.id }
      await this.owner.credentials.set(this.secretRef(binding), parsed.data.secret)
      try {
        await domain.table('bindings').put(id, binding)
      } catch (_error) {
        this.owner.logger.warn('WeCom binding write failed; credentials were retained for recovery. Refresh robot status before retrying authorization')
        throw new RemoteError('wecom/authorization-uncertain', 'Binding could not be confirmed; refresh robot status before retrying', {})
      }
      this.notify()
      await this.connect(binding)
      return binding
    })
  }

  /** Enable/reconnect or disable an existing robot without changing its pinned release.
   * @param id - exact binding identity.
   * @param enabled - false stops admission and drains the connection; true reconnects it.
   * @returns after durable enablement and connection lifecycle reconciliation.
   */
  @Remote
  setEnabled(id: WecomBindingId, enabled: boolean): Promise<void> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const table = (await this.ready).table('bindings')
      const binding = table.get(id)
      if (binding === undefined || binding.ownerId !== ownerId) throw new RemoteError('wecom/not-found', 'Robot binding not found', {})
      await table.put(id, { ...binding, enabled })
      this.notify()
      await this.channels.get(id)?.close()
      this.channels.delete(id)
      this.statuses.delete(id)
      if (enabled) await this.connect({ ...binding, enabled })
      this.notify()
    })
  }

  /** Request scan authorization for one saved published release without publishing a draft.
   * @param agentId - saved Agent belonging to this deployment owner.
   * @param releaseId - exact published release shown in the Agent information panel.
   * @returns pending scan request; no robot credentials or binding exist until completion.
   */
  @Remote
  requestRelease(agentId: CloudAgentId, releaseId: CloudAgentReleaseId): Promise<WecomRequest> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const record = (await this.owner.cloudAgents.catalog()).mine.find(item => item.id === agentId)
      const release = record?.releases.find(item => item.id === releaseId && item.kind === 'published')
      if (record === undefined || release === undefined) throw new RemoteError('wecom/release-changed', 'Refresh the Agent information before authorizing', {})
      if (record.ownerId !== ownerId) throw new RemoteError('wecom/owner-required', 'Only the Agent owner can authorize a robot', {})
      return this.saveRequest(agentId, release.id, release.definition.name, ownerId, true)
    })
  }

  private async saveRequest(agentId: CloudAgentId, releaseId: CloudAgentReleaseId, name: string,
    ownerId: CloudAgentOwnerId, reuse = false): Promise<WecomRequest> {
    const domain = await this.ready
    const table = domain.table('requests')
    const bound = new Set([...domain.table('bindings').entries()].filter(([, value]) => value.ownerId === ownerId).map(([, value]) => value.requestId))
    for (const [id, value] of table.entries()) {
      if (value.expiresAt <= Date.now()) await table.delete(id)
      else if (reuse && value.ownerId === ownerId && value.agentId === agentId
        && value.releaseId === releaseId && !bound.has(id)) return value
    }
    if ([...table.entries()].length >= this.config.maxRequests) throw new RemoteError('wecom/limit', 'Too many pending authorizations; retry later', {})
    const request: WecomRequest = { id: brandString<WecomRequestId>(randomUUID()), ownerId, agentId, releaseId,
      name, expiresAt: Date.now() + this.config.authorizationTimeoutMs, bindingId: null }
    await table.put(request.id, request)
    this.notify()
    return request
  }

  private secretRef(binding: WecomBinding) {
    return credentialRef(`WECOM_BOT_${binding.id.toUpperCase()}_${binding.requestId.replaceAll('-', '').toUpperCase()}`)
  }

  private async connect(binding: WecomBinding): Promise<void> {
    await this.channels.get(binding.id)?.close()
    this.channels.delete(binding.id)
    const secret = await this.owner.credentials.resolve(this.secretRef(binding))
    if (secret === undefined) {
      this.statuses.set(binding.id, 'offline')
      this.owner.logger.warn('WeCom robot credentials are missing; authorize the robot again')
      this.notify()
      return
    }
    const channel = new WecomChannel(this.owner, this.config, binding, secret.value,
      (conversation, delivery, signal) => this.admit(binding, conversation, delivery, signal),
      (status) => { if (!this.stopping) { this.statuses.set(binding.id, status); this.notify() } })
    this.channels.set(binding.id, channel)
    channel.start()
  }

  private admit(binding: WecomBinding, conversation: string, delivery: string, signal: AbortSignal): Promise<WecomAdmission | null> {
    const pending = this.admissions.then(async () => {
      if (this.stopping) return null
      signal.throwIfAborted()
      const domain = await this.ready
      if (domain.table('bindings').get(binding.id)?.enabled !== true) return null
      const receipt = routingHash(binding.id, delivery)
      const receipts = domain.table('receipts')
      const prior = receipts.get(receipt)
      if (this.submitted.has(receipt) || prior?.state === 'submitted') return null
      if (prior !== undefined) {
        throw new RemoteError('wecom/delivery-uncertain', 'A prior delivery may have been submitted; inspect the Harness Session before repeating operations', {})
      }
      if ([...receipts.entries()].length >= this.config.maxReceipts) {
        throw new RemoteError('wecom/limit', 'Delivery receipt limit reached; increase the configured limit before accepting more messages', {})
      }
      const id = brandString<WecomConversationId>(routingHash(binding.id, conversation))
      const existing = domain.table('conversations').get(id)
      let agent: Agent
      if (existing === undefined) {
        if ([...domain.table('conversations').entries()].length >= this.config.maxConversations) throw new RemoteError('wecom/limit', 'Conversation limit reached', {})
        const created = await this.owner.cloudAgents.startRetainedSession(
          { id: binding.agentId, releaseId: binding.releaseId }, binding.ownerId, signal)
        const live = this.owner.agents.get(created.sessionId)
        if (live === undefined) throw new Error('Cloud Agent Session did not become live')
        await domain.table('conversations').put(id, { bindingId: binding.id, ownerId: binding.ownerId, sessionId: created.sessionId })
        agent = live
      } else {
        const resolved = await this.owner.sessionController.resolveAgent(existing.sessionId)
        if (!('agent' in resolved)) throw new Error('WeCom conversation could not be resumed')
        agent = resolved.agent
      }
      signal.throwIfAborted()
      await receipts.put(receipt, { state: 'pending', time: Date.now() })
      let committed = false
      return {
        agent,
        commit: () => {
          committed = true
          this.submitted.add(receipt)
          return receipts.put(receipt, { state: 'submitted', time: Date.now() })
        },
        release: async () => { if (!committed) await receipts.delete(receipt) },
      }
    })
    this.admissions = pending.then(() => {}, () => {})
    return pending
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new RemoteError('wecom/stopping', 'WeCom plugin is stopping', {}))
    const pending = this.chain.then(() => { if (this.stopping) throw new RemoteError('wecom/stopping', 'WeCom plugin is stopping', {}); return operation() })
    this.chain = pending.then(() => {}, () => {})
    return pending
  }

  private notify(): void { for (const subscriber of this.subscribers) subscriber() }

  private async close(): Promise<void> {
    this.stopping = true
    this.notify()
    await this.initialized.catch((_error: unknown) => { /* Loader reports initialization failures. */ })
    await this.chain
    const results = await Promise.allSettled([...this.channels.values()].map(channel => channel.close()))
    await this.admissions
    this.channels.clear()
    this.submitted.clear()
    this.subscribers.clear()
    await (await this.ready).close()
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'WeCom teardown failed')
  }
}

export default CompanyWecomService
