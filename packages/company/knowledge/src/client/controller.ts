/** Knowledge management state with retained results, classified failures and teardown-owned cancellation. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { remoteErrorOf, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-company-knowledge/remote'
import type { CompanyKnowledgeCatalog, CompanyKnowledgeSearchRequest, CompanyKnowledgeSearchResult } from '../types.ts'

/** Failure shown on the page; each kind has its own copy. */
export type KnowledgeFailure = 'load' | 'search' | 'timeout' | 'changed'
/** Outcome of the most recent completed search of one source. */
export type KnowledgeSourceStatus = { readonly kind: 'found'; readonly hits: number } | { readonly kind: 'empty' | 'failed' }

/** One successful search and the request that produced it. */
export interface KnowledgeOutcome {
  readonly request: CompanyKnowledgeSearchRequest
  readonly value: CompanyKnowledgeSearchResult
}

/** Page state; `catalog` and `result` keep the last confirmed values across failures. */
export interface KnowledgeView {
  readonly catalog: CompanyKnowledgeCatalog | null
  readonly loading: boolean
  readonly searching: boolean
  readonly failure: KnowledgeFailure | null
  readonly result: KnowledgeOutcome | null
  /** Request of the latest search attempt, reused by retry. */
  readonly lastRequest: CompanyKnowledgeSearchRequest | null
  readonly statuses: Readonly<Record<string, KnowledgeSourceStatus>>
}

/** Generated knowledge management methods the controller calls. */
export type KnowledgeControllerApi = Pick<ClientRemote['companyKnowledge'], 'catalog' | 'test'>

/** Observable page state and its management operations. */
export interface KnowledgeInjected {
  readonly hooks: { readonly companyKnowledge: HostObservable<KnowledgeView> }
  readonly refreshKnowledge: () => Promise<void>
  readonly testKnowledge: (request: CompanyKnowledgeSearchRequest) => Promise<void>
  readonly cancelKnowledge: () => void
  readonly retryKnowledge: () => Promise<void>
}

function searchFailure(error: RemoteFailure): KnowledgeFailure {
  switch (error.code) {
    case 'company-knowledge/search-failed': return error.details.reason === 'timeout' ? 'timeout' : 'search'
    case 'company-knowledge/binding-changed':
    case 'company-knowledge/not-found': return 'changed'
    // Other codes are carrier or validation failures without a dedicated page state.
    default: return 'search'
  }
}

/** Own one source catalog load and at most one search at a time. */
export class KnowledgeController {
  private snapshot: KnowledgeView = {
    catalog: null, loading: true, searching: false, failure: null, result: null, lastRequest: null, statuses: {},
  }
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private loadActive = false
  private search: AbortController | undefined
  /** @param api - owner management Remote methods. */
  constructor(private readonly api: KnowledgeControllerApi) {}

  /** Return stable current page state.
   * @returns the latest committed snapshot.
   */
  getSnapshot = (): KnowledgeView => this.snapshot
  /** Observe committed page changes.
   * @param listener - framework observer.
   * @returns listener disposer.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  /** Provide plain page actions and the framework-owned observable.
   * @returns the registration inject face.
   */
  face(): KnowledgeInjected {
    return {
      hooks: { companyKnowledge: this },
      refreshKnowledge: () => this.track(this.refresh()),
      testKnowledge: request => this.track(this.test(request)),
      cancelKnowledge: () => { this.search?.abort() },
      retryKnowledge: () => {
        const request = this.snapshot.lastRequest
        const reload = this.snapshot.failure === 'load' || this.snapshot.failure === 'changed' || request === null
        return this.track(reload ? this.refresh() : this.test(request))
      },
    }
  }

  /** Cancel and drain management work before unmounting Remote methods. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
    this.listeners.clear()
  }

  private async refresh(): Promise<void> {
    if (this.lifetime.signal.aborted || this.loadActive) return
    this.loadActive = true
    this.set({ loading: true, failure: this.snapshot.failure === 'load' ? null : this.snapshot.failure })
    try {
      const result = await this.api.catalog()
      if (result.ok) this.set({ catalog: result.value, failure: this.snapshot.failure === 'changed' ? null : this.snapshot.failure })
      else this.set({ failure: 'load' })
    } catch (_error: unknown) {
      this.set({ failure: 'load' })
    } finally {
      this.loadActive = false
      this.set({ loading: false })
    }
  }

  private async test(request: CompanyKnowledgeSearchRequest): Promise<void> {
    if (this.lifetime.signal.aborted || this.search !== undefined) return
    const search = new AbortController()
    this.search = search
    this.set({ searching: true, failure: null, lastRequest: request })
    try {
      const result = await this.api.test(request, AbortSignal.any([search.signal, this.lifetime.signal]))
      if (result.ok) {
        const hits = result.value.hits.length
        const status: KnowledgeSourceStatus = hits > 0 ? { kind: 'found', hits } : { kind: 'empty' }
        this.set({ result: { request, value: result.value }, statuses: { ...this.snapshot.statuses, [request.sourceId]: status } })
      } else if (!search.signal.aborted) {
        this.set({ failure: searchFailure(result.error), statuses: { ...this.snapshot.statuses, [request.sourceId]: { kind: 'failed' } } })
      }
    } catch (error: unknown) {
      if (!search.signal.aborted) {
        const remote = remoteErrorOf(error)
        this.set({ failure: remote === undefined ? 'search' : searchFailure(remote),
          statuses: { ...this.snapshot.statuses, [request.sourceId]: { kind: 'failed' } } })
      }
    } finally {
      this.search = undefined
      this.set({ searching: false })
    }
  }

  private track(work: Promise<void>): Promise<void> {
    this.pending.add(work)
    const settle = (): void => { this.pending.delete(work) }
    void work.then(settle, settle)
    return work
  }

  private set(patch: Partial<KnowledgeView>): void {
    if (this.lifetime.signal.aborted) return
    this.snapshot = { ...this.snapshot, ...patch }
    notifySubscribers(this.listeners, 'company-knowledge')
  }
}
