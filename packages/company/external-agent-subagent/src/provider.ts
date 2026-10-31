/** Per-agent execution ownership and continuation behind the standard subagent seam. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ExternalAgentAdapter, ExternalAgentAnswer } from './dify.ts'
import { validUnicode } from './dify.ts'
import { abortable, ExternalAgentError, failure } from './error.ts'
import type { ExternalAgentDescriptor, ExternalAgentFailure, ExternalAgentRunDescriptor } from './types.ts'

/** Private provider request forwarded by the activation manager's request copy, never a model/tool JSON field. */
export interface ExternalAgentProviderRequest extends ResolvedSubagentStartRequest {
  readonly externalAgentContinuation?: SessionId
}

/** Explicit execution policy plus safe logical identity. */
export interface ExternalAgentProviderSpec {
  readonly descriptor: ExternalAgentDescriptor
  readonly credentialRef: CredentialRef
  readonly timeoutMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxRetainedRuns: number
}

interface Conversation {
  readonly owner: Agent
  readonly conversationId: ExternalAgentAnswer['conversationId']
  readonly user: string
  tail: SessionId
  state: 'idle' | 'busy' | 'unknown'
}

interface RetainedRun {
  readonly owner: Agent
  descriptor: ExternalAgentRunDescriptor
  conversation?: Conversation
}

/** Hash a complete value for safe input/output references without retaining its content. */
function summary(text: string): { sha256: string; bytes: number } {
  return { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text, 'utf8') }
}

/** One logical external agent; accepted executions have independent lifecycle controllers. */
export class ExternalPlatformProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
  readonly inheritsParentContext = false
  private readonly lifetime = new AbortController()
  private readonly runs = new Map<SessionId, RetainedRun>()
  private readonly active = new Map<SessionId, { controller: AbortController; result: Promise<SubagentResult> }>()
  private disposal: Promise<void> | undefined
  private readonly agents: AgentRegistry

  /** @param ctx - declared credentials and live-Agent services.
   * @param spec - explicit private policy and logical descriptor.
   * @param adapter - replaceable platform implementation.
   */
  constructor(
    private readonly ctx: Context,
    private readonly spec: ExternalAgentProviderSpec,
    private readonly adapter: ExternalAgentAdapter,
  ) {
    this.name = spec.descriptor.providerName
    this.agents = ctx.agents
  }

  /** Read logical deployment facts only.
   * @returns the safe descriptor, including unload status.
   */
  describe(): ExternalAgentDescriptor {
    return { ...this.spec.descriptor, status: this.lifetime.signal.aborted ? 'disposed' : 'configured' }
  }

  /** Read retained facts only under the exact original parent identity.
   * @param parent - live parent claiming this child.
   * @param childId - provider-minted child identity.
   * @returns safe descriptor; rejects unavailable or foreign children.
   */
  describeRun(parent: Agent, childId: SessionId): ExternalAgentRunDescriptor {
    return this.ownedRun(parent, childId).descriptor
  }

  /** Establish a logical child before asynchronous credentials/HTTP execution.
   * @param request - standard request, with a Host-only continuation address when explicitly selected.
   * @returns independent run; execution failures resolve with a diagnostic, never partial success.
   */
  start(request: ExternalAgentProviderRequest): Promise<SubagentRun> {
    return Promise.resolve().then(() => this.createRun(request))
  }

  /** Admission and active-run publication are synchronous and cannot interleave with disposal. */
  private createRun(request: ExternalAgentProviderRequest): SubagentRun {
    if (this.lifetime.signal.aborted) throw failure('disposed', 'not-sent')
    if (request.signal.aborted) throw failure('aborted', 'not-sent')
    if (this.agents.get(request.parent.id) !== request.parent) throw failure('continuation-owner', 'not-sent')
    if (request.agentOptions !== undefined || request.agentPreset !== undefined
      || request.outputSchema !== undefined || request.maxDepth !== undefined) {
      throw failure('configuration', 'not-sent')
    }
    if (request.prompt.length === 0 || request.prompt.some(block => block.type !== 'text' || !validUnicode(block.text))) {
      throw failure('invalid-input', 'not-sent')
    }
    const query = request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (query.trim().length === 0) throw failure('invalid-input', 'not-sent')
    if (Buffer.byteLength(query, 'utf8') > this.spec.maxInputBytes) throw failure('input-limit', 'not-sent')
    if (this.runs.size >= this.spec.maxRetainedRuns) throw failure('capacity', 'not-sent')
    const prior = request.externalAgentContinuation
    let conversation: Conversation | undefined
    if (prior !== undefined) {
      if (!this.spec.descriptor.continuationAllowed) throw failure('continuation-disabled', 'not-sent')
      conversation = this.ownedRun(request.parent, prior).conversation
      if (conversation === undefined || conversation.state === 'unknown' || conversation.tail !== prior) {
        throw failure('continuation-unavailable', 'not-sent')
      }
      if (conversation.state === 'busy') throw failure('continuation-busy', 'not-sent')
      conversation.state = 'busy'
    }
    const id = brandString<SessionId>(randomUUID())
    const user = conversation?.user ?? summary(JSON.stringify([this.name, request.parent.id, this.spec.descriptor.id,
      this.spec.descriptor.version, this.spec.descriptor.environment])).sha256
    const record: RetainedRun = {
      owner: request.parent,
      descriptor: {
        childId: id, parentSessionId: request.parent.id, agent: this.describe(),
        ...(prior === undefined ? {} : { continuationOf: prior }),
        input: summary(query), startedAt: Date.now(), state: { status: 'running' },
      },
    }
    this.runs.set(id, record)
    const controller = new AbortController()
    let sent = false
    const effect = (): ExternalAgentFailure['effect'] => sent ? 'unknown' : 'not-sent'
    const cancel = (code: 'aborted' | 'timeout' | 'disposed'): void => { controller.abort(failure(code, effect())) }
    const onAbort = (): void => { cancel('aborted') }
    const onDispose = (): void => { cancel('disposed') }
    request.signal.addEventListener('abort', onAbort, { once: true })
    this.lifetime.signal.addEventListener('abort', onDispose, { once: true })
    const timer = setTimeout(() => { cancel('timeout') }, this.spec.timeoutMs)
    const completion = Promise.withResolvers<SubagentResult>()
    const result = completion.promise
    this.active.set(id, { controller, result })
    const execute = async (): Promise<SubagentResult> => {
      try {
        controller.signal.throwIfAborted()
        const credential = await abortable(Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return this.ctx.credentials.resolve(this.spec.credentialRef)
        }).catch((error: unknown) => { throw failure('credential-unavailable', 'not-sent', error) }), controller.signal)
        controller.signal.throwIfAborted()
        if (credential === undefined || !/^[\x21-\x7e]+$/.test(credential.value)) throw failure('credential-unavailable', 'not-sent')
        const answer = await this.adapter.call({
          query, user, signal: controller.signal, credential: credential.value,
          ...(conversation === undefined ? {} : { conversationId: conversation.conversationId }),
        }, () => { sent = true })
        controller.signal.throwIfAborted()
        const completed: SubagentResult = { output: [{ type: 'text', text: answer.answer }], stopReason: 'completed' }
        if (Buffer.byteLength(JSON.stringify(completed), 'utf8') > this.spec.maxOutputBytes) throw failure('response-size', 'unknown')
        record.descriptor = {
          ...record.descriptor, state: { status: 'completed', endedAt: Date.now(), output: summary(answer.answer) },
        }
        if (this.spec.descriptor.continuationAllowed) {
          const thread = conversation ?? { owner: request.parent, conversationId: answer.conversationId, user, tail: id, state: 'idle' }
          thread.tail = id
          thread.state = 'idle'
          record.conversation = thread
        }
        return completed
      } catch (error: unknown) {
        const safe = controller.signal.aborted && controller.signal.reason instanceof ExternalAgentError
          ? controller.signal.reason
          : error instanceof ExternalAgentError ? error : failure('transport', effect(), error)
        if (conversation !== undefined) conversation.state = sent ? 'unknown' : 'idle'
        record.descriptor = {
          ...record.descriptor, state: { status: 'failed', endedAt: Date.now(), failure: safe.failure },
        }
        return {
          output: [], diagnostic: safe.message,
          stopReason: safe.failure.code === 'aborted' || safe.failure.code === 'disposed' ? 'aborted' : 'error',
        }
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
        this.lifetime.signal.removeEventListener('abort', onDispose)
        this.active.delete(id)
      }
    }
    void execute().then(completion.resolve, completion.reject)
    return {
      id, result,
      dispose: async () => {
        if (this.active.has(id)) cancel('aborted')
        await result
      },
    }
  }

  /** Stop admission, abort every operation and await HTTP/body cleanup.
   * @returns once all operation-owned work settles; retained facts remain readable.
   */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.lifetime.abort()
      await Promise.all([...this.active.values()].map(run => run.result))
    })()
  }

  /** Exact live identity is required; durable ids alone cannot authorize continuation. */
  private ownedRun(parent: Agent, childId: SessionId): RetainedRun {
    const record = this.runs.get(childId)
    if (record === undefined) throw failure('continuation-unavailable', 'not-sent')
    if (record.owner !== parent || this.agents.get(parent.id) !== parent) throw failure('continuation-owner', 'not-sent')
    return record
  }
}
