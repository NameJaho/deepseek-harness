/** Shared publication state and plugin-owned browser authorization lifecycle. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-company-wecom/remote'
import type { WecomBinding, WecomBindingId, WecomRequestId, WecomSnapshot } from '../types.ts'
import { WecomAuthorizationError, WecomAuthorizationPopup } from './authorization.ts'
import type { WecomAuthorizationErrorCode } from './authorization.ts'
import type { WecomLocaleKey } from './locales.ts'

type Api = Pick<ClientRemote['companyWecom'], 'snapshot' | 'complete' | 'setEnabled' | 'requestRelease'>
type Stream = Pick<RemoteStream<WecomSnapshot>, 'dispose' | typeof Symbol.asyncIterator>
const authorizationErrors: Record<WecomAuthorizationErrorCode, WecomLocaleKey> = {
  WINDOW_BLOCKED: 'blocked', CANCELLED: 'cancelled', AUTH_TIMEOUT: 'expired', INVALID_RESPONSE: 'failed',
}

/** Credential-free view shared by the tool card, management page and shell toast. */
export interface WecomView {
  snapshot: WecomSnapshot | null
  busy: WecomRequestId | WecomBindingId | 'refresh' | null
  /** Persistent snapshot/stream failure; mutations never clear it. */
  error: WecomLocaleKey | null
  /** Unknown completion forbids further scans until a successful explicit refresh. */
  authorizationUncertain: WecomRequestId | null
  notice: { sequence: number; key: WecomLocaleKey; success: boolean } | null
}

/** Narrow slot inputs; authorization credentials never enter the observable state. */
export interface WecomInjected {
  hooks: { wecom: HostObservable<WecomView> }
  authorize: (id: WecomRequestId) => void
  requestRelease: (agentId: import('@deepseek-ai/dsh-company-cloud-agent/types').CloudAgentId,
    releaseId: import('@deepseek-ai/dsh-company-cloud-agent/types').CloudAgentReleaseId) => void
  setEnabled: (id: WecomBindingId, enabled: boolean) => void
  refresh: () => void
  dismissNotice: (sequence: number) => void
}

/** Owns the popup and drains API calls and stream callbacks before Remote unload. */
export class WecomController {
  private readonly authorization = new WecomAuthorizationPopup()
  private readonly subscribers = new Set<() => void>()
  private view: WecomView = { snapshot: null, busy: null, error: null, authorizationUncertain: null, notice: null }
  private sequence = 0
  private stream: Stream | undefined
  private pump: Promise<void> = Promise.resolve()
  private mutation: Promise<void> = Promise.resolve()
  private disposed = false
  private closing: Promise<void> | undefined

  /**
   * @param api - generated management methods.
   * @param open - Gateway-owned reconnecting snapshot stream.
   */
  constructor(private readonly api: Api, private readonly open: () => Stream) {}

  /** Read the current credential-free view.
   * @returns the stable observable snapshot.
   */
  getSnapshot = (): WecomView => this.view

  /** Subscribe a framework-bound hook; disposed controllers retain no observers.
   * @param callback - snapshot invalidation observer.
   * @returns subscription disposer.
   */
  subscribe = (callback: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.subscribers.add(callback)
    return () => { this.subscribers.delete(callback) }
  }

  /** Start consuming publication state after Remote mounting; opening failures remain visible. */
  start(): void {
    if (this.stream !== undefined || this.disposed) return
    try {
      this.stream = this.open()
      this.pump = this.consume(this.stream)
    } catch (_error) { this.set({ error: 'statusFailed' }) }
  }

  /** Build stable actions and the framework observable hook seat.
   * @returns shared injection; refresh and mutations are mutually exclusive.
   */
  face(): WecomInjected {
    return {
      hooks: { wecom: this },
      authorize: (id) => { this.authorize(id) },
      requestRelease: (agentId, releaseId) => {
        this.run('refresh', async () => {
          const result = await this.api.requestRelease(agentId, releaseId)
          if (!result.ok) { this.report('versionChanged'); return }
          const snapshot = this.view.snapshot
          if (snapshot !== null) this.set({ snapshot: { ...snapshot,
            requests: [...snapshot.requests.filter(request => request.id !== result.value.id), result.value] } })
          this.report('scanReady', true)
        })
      },
      setEnabled: (id, enabled) => { this.changeEnabled(id, enabled) },
      refresh: () => {
        this.run('refresh', async () => {
          const before = this.view.snapshot
          const result = await this.api.snapshot()
          if (!result.ok) { this.set({ error: 'statusFailed' }); return }
          const stream = this.stream
          this.stream = undefined
          await stream?.dispose()
          await this.pump
          if (this.disposed) return
          // A later stream frame takes precedence over an overlapping unary read.
          const snapshot = this.view.snapshot === before ? result.value : this.view.snapshot
          this.set({ snapshot, error: null, authorizationUncertain: null })
          this.start()
          if (this.view.error === null) this.report('refreshed', true)
        }, () => { this.set({ error: 'statusFailed' }) })
      },
      dismissNotice: (sequence) => {
        if (this.view.notice?.sequence === sequence) this.set({ notice: null })
      },
    }
  }

  /**
   * Cancel authorization and stop publication immediately. Already-started API
   * calls may commit and are drained, even if stream cleanup fails.
   * @returns after the popup, stream consumer and API calls are quiescent; repeated calls share teardown.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    this.subscribers.clear()
    this.authorization.cancel()
    this.closing = this.close()
    return this.closing
  }

  private async close(): Promise<void> {
    const results = await Promise.allSettled([this.stream?.dispose(), this.pump, this.mutation])
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'WeCom client teardown failed')
  }

  private async consume(stream: Stream): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.disposed || this.stream !== stream) return
        this.set({ snapshot: item.value, error: null })
        item.accept()
      }
      if (this.stream === stream) this.set({ error: 'statusFailed' })
    } catch (_error) {
      if (this.stream === stream) this.set({ error: 'statusFailed' })
    }
  }

  private authorize(id: WecomRequestId): void {
    if (this.disposed || this.view.busy !== null) return
    if (this.view.authorizationUncertain !== null) { this.report('authorization-uncertain'); return }
    const snapshot = this.view.snapshot
    const request = snapshot?.requests.find(item => item.id === id)
    if (snapshot === null || request === undefined) { this.report('unavailable'); return }
    if (request.bindingId !== null) return
    if (request.expiresAt <= Date.now()) { this.report('expired'); return }
    this.run(id, async () => {
      // Open in the user gesture, before awaiting any RPC or asynchronous work.
      const bot = await this.authorization.open({ source: snapshot.source, expiresAt: request.expiresAt })
      if (this.disposed) return
      let result: Awaited<ReturnType<Api['complete']>>
      try {
        result = await this.api.complete({ requestId: id, botId: bot.botid, secret: bot.secret })
      } catch (_error) {
        this.uncertain(id)
        return
      }
      if (result.ok) {
        this.setAuthorizedBinding(result.value)
        await this.refreshAfterAuthorization()
        this.report('authorized', true)
        return
      }
      switch (result.error.code) {
        case 'wecom/expired': this.report('expired'); break
        case 'wecom/release-changed': this.report('versionChanged'); break
        case 'wecom/owner-required':
        case 'wecom/invalid-authorization':
        case 'wecom/already-bound':
        case 'wecom/limit':
        case 'wecom/stopping': this.report('failed'); break
        // Transport errors and unfamiliar completion failures do not establish non-commit.
        default: this.uncertain(id)
      }
    })
  }

  private uncertain(id: WecomRequestId): void {
    this.set({ authorizationUncertain: id })
    this.report('authorization-uncertain')
  }

  /** Show the committed binding immediately, then replace it with authoritative status. */
  private setAuthorizedBinding(binding: WecomBinding): void {
    const current = this.view.snapshot
    if (current === null) return
    const previous = current.bindings.find(item => item.id === binding.id)
    const next: WecomSnapshot['bindings'][number] = { ...binding, status: previous?.status ?? 'connecting' }
    this.set({ snapshot: {
      ...current,
      requests: current.requests.map(request => request.id === binding.requestId
        ? { ...request, bindingId: binding.id } : request),
      bindings: [...current.bindings.filter(item => item.id !== binding.id), next],
    } })
  }

  /** Confirm the durable binding after the credential exchange without restarting the live stream. */
  private async refreshAfterAuthorization(): Promise<void> {
    try {
      const result = await this.api.snapshot()
      if (result.ok) this.set({ snapshot: result.value, error: null, authorizationUncertain: null })
      else this.set({ error: 'statusFailed' })
    } catch (_error) {
      this.set({ error: 'statusFailed' })
    }
  }

  private changeEnabled(id: WecomBindingId, enabled: boolean): void {
    this.run(id, async () => {
      const result = await this.api.setEnabled(id, enabled)
      this.report(result.ok ? enabled ? 'connectRequested' : 'robotDisabled' : 'enablementFailed', result.ok)
    }, () => { this.report('enablementFailed') })
  }

  private run(busy: NonNullable<WecomView['busy']>, operation: () => Promise<void>, failed?: () => void): void {
    if (this.disposed || this.view.busy !== null) return
    const pending = Promise.withResolvers<void>()
    // Reserve teardown ownership before observers can dispose or invoke another action.
    this.mutation = pending.promise
    this.set({ busy })
    void (async () => {
      try {
        if (!this.disposed) await operation()
      } catch (error) {
        if (failed !== undefined) failed()
        else this.report(error instanceof WecomAuthorizationError ? authorizationErrors[error.code] : 'failed')
      } finally {
        this.set({ busy: null })
        pending.resolve()
      }
    })()
  }

  private report(key: WecomLocaleKey, success = false): void {
    this.set({ notice: { sequence: ++this.sequence, key, success } })
  }

  private set(patch: Partial<WecomView>): void {
    if (this.disposed) return
    this.view = { ...this.view, ...patch }
    notifySubscribers(this.subscribers, 'company-wecom')
  }
}
