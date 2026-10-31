/** Reconnecting, browser-safe MCP management with retained data and explicit retry. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanyMcpCatalog, CompanyMcpId } from '../types.ts'
import type {} from '@deepseek-ai/dsh-company-mcp-provider/remote'
import type { CloudAgentLocaleKey } from './locales.ts'

/** Last confirmed directory and the current operation state. */
export interface McpView {
  readonly catalog: CompanyMcpCatalog | null
  readonly error: boolean
  readonly loading: boolean
  readonly busy: boolean
}

/** Generated MCP management methods the controller calls. */
export type McpControllerApi = Pick<ClientRemote['companyMcp'], 'refresh' | 'discover' | 'configure'>
/** Directory stream members the controller consumes. */
export type McpCatalogStream = Pick<RemoteStream<CompanyMcpCatalog>, 'dispose' | typeof Symbol.asyncIterator>

/** No connection settings or credentials cross the injected face. */
export interface McpInjected {
  readonly hooks: { readonly companyMcp: HostObservable<McpView> }
  readonly refreshMcp: () => Promise<void>
  readonly retryMcp: () => Promise<void>
  readonly discoverMcp: (id: CompanyMcpId) => Promise<void>
  readonly configureMcp: (id: CompanyMcpId, enabled: boolean) => Promise<void>
}

/** Owns the stream and prevents duplicate operations and late publications after disposal. */
export class McpController {
  private snapshot: McpView = { catalog: null, error: false, loading: true, busy: false }
  private readonly listeners = new Set<() => void>()
  private stream: McpCatalogStream | undefined
  private pump: Promise<void> = Promise.resolve()
  private mutation: Promise<void> = Promise.resolve()
  private readonly cancellation = new AbortController()
  private stopped = false
  private streamFailed = false
  private retry: (() => Promise<void>) | undefined

  /** @param api - generated CompanyMcpRemote methods.
   * @param makeStream - Gateway-owned reconnecting directory stream.
   * @param notify - shell-owned operation outcomes.
   */
  constructor(private readonly api: McpControllerApi, private readonly makeStream: () => McpCatalogStream,
    private readonly notify: (key: CloudAgentLocaleKey, success: boolean) => void) {}

  /** Stable source snapshot read by framework-bound hooks. */
  getSnapshot = (): McpView => this.snapshot
  /**
   * Observe source changes.
   * @param listener - framework observer.
   * @returns observer disposer.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  /** Begin a single stream for this lifecycle. */
  start(): void {
    if (this.stopped || this.stream !== undefined) return
    try {
      this.stream = this.makeStream()
      this.pump = this.consume(this.stream)
    } catch (_streamError: unknown) {
      this.streamFailed = true
      this.set({ error: true, loading: false })
    }
  }

  /**
   * Build the narrow component action face once at registration.
   * @returns the narrow management and retry actions.
   */
  face(): McpInjected {
    const refreshMcp = (): Promise<void> => this.run(async () => {
      if (this.streamFailed) {
        await this.stream?.dispose()
        await this.pump
        this.stream = undefined
        this.streamFailed = false
        this.start()
      }
      const result = await this.api.refresh(this.cancellation.signal)
      if (!result.ok) throw result.error
      this.acceptCatalog(result.value)
      if (result.value.failure !== undefined || !result.value.loaded) throw new Error('MCP refresh failed')
    }, 'mcpRefreshed', refreshMcp)
    const discoverMcp = (id: CompanyMcpId): Promise<void> => this.run(async () => {
      const result = await this.api.discover({ id }, this.cancellation.signal)
      if (!result.ok) throw result.error
      const catalog = this.snapshot.catalog
      if (catalog !== null) this.set({ catalog: { ...catalog, servers: catalog.servers.map(server =>
        server.id === id ? { ...server, tools: result.value } : server) } })
    }, 'mcpConnected', () => discoverMcp(id))
    const configureMcp = (id: CompanyMcpId, enabled: boolean): Promise<void> => this.run(async () => {
      const result = await this.api.configure({ id, enabled })
      if (!result.ok) throw result.error
      this.acceptCatalog(result.value)
      if (result.value.failure !== undefined) throw new Error('MCP configuration failed')
    }, 'mcpConfigured', () => configureMcp(id, enabled))
    return { hooks: { companyMcp: this }, refreshMcp, discoverMcp, configureMcp,
      retryMcp: () => (this.retry ?? refreshMcp)() }
  }

  /** Cancel and drain all work before the Remote namespace unmounts. */
  async dispose(): Promise<void> {
    this.stopped = true
    this.cancellation.abort()
    await this.stream?.dispose()
    await Promise.all([this.pump, this.mutation])
    this.listeners.clear()
  }

  private async consume(stream: McpCatalogStream): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.stopped) return
        this.acceptCatalog(item.value)
        item.accept()
      }
      if (!this.stopped) { this.streamFailed = true; this.set({ error: true, loading: false }) }
    } catch (_streamError: unknown) {
      if (!this.stopped) { this.streamFailed = true; this.set({ error: true, loading: false }) }
    }
  }

  private acceptCatalog(catalog: CompanyMcpCatalog): void {
    const failed = catalog.failure !== undefined || !catalog.loaded
    const retained = failed && this.snapshot.catalog?.loaded ? this.snapshot.catalog : catalog
    this.set({ catalog: retained, error: failed, loading: false })
  }

  private set(patch: Partial<McpView>): void {
    if (this.stopped) return
    this.snapshot = { ...this.snapshot, ...patch }
    notifySubscribers(this.listeners, 'company-mcp')
  }

  private async run(operation: () => Promise<void>, success: CloudAgentLocaleKey, retry: () => Promise<void>): Promise<void> {
    if (this.stopped || this.snapshot.busy) return
    this.set({ busy: true })
    const pending = Promise.resolve().then(() => {
      if (!this.stopped) return operation()
    }).then(() => {
      if (!this.stopped) { this.retry = undefined; this.set({ error: false }); this.notify(success, true) }
    }, (_operationError: unknown) => {
      if (!this.stopped) { this.retry = retry; this.set({ error: true }); this.notify('mcpFailed', false) }
    }).finally(() => { this.set({ busy: false }) })
    this.mutation = pending
    await pending
  }
}
