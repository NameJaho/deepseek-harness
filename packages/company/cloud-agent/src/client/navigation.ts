/** Caller-scoped logical Agent groups over the existing ui-workspace navigation seam. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  WorkspaceNavigationGroup, WorkspaceNavigationGroupSource,
} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CloudAgentCatalog, CloudAgentId } from '../types.ts'
import type { CloudAgentView } from './controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Keeps the Agent navigation provider registered while a connection generation is replaced.
 * `undefined` withholds physical Workspace rows until the replacement catalog is known.
 */
export class AgentNavigationGroupsGate implements WorkspaceNavigationGroupSource {
  private source: WorkspaceNavigationGroupSource | undefined
  private sourceStop: (() => void) | undefined
  private readonly listeners = new Set<() => void>()

  /** @returns the current generation's groups, or `undefined` while it is unavailable. */
  getSnapshot = (): readonly WorkspaceNavigationGroup[] | undefined => this.source?.getSnapshot()
  /** @param listener - observer of source replacement and catalog changes.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** Replace the active connection generation's source.
   * @param source - the current connection generation's groups, or `undefined` during replacement.
   */
  set(source: WorkspaceNavigationGroupSource | undefined): void {
    if (this.source === source) return
    this.sourceStop?.()
    this.sourceStop = undefined
    this.source = source
    if (source !== undefined) this.sourceStop = source.subscribe(this.notify)
    notifySubscribers(this.listeners, 'Agent navigation lifecycle')
  }
  /** Release the source and all observers. */
  dispose(): void {
    this.sourceStop?.()
    this.sourceStop = undefined
    this.source = undefined
    this.listeners.clear()
  }
  private notify = (): void => {
    notifySubscribers(this.listeners, 'Agent navigation')
  }
}

/** One reactive provider per authenticated Agent catalog lifecycle; it persists no member state. */
export class AgentNavigationGroups implements WorkspaceNavigationGroupSource {
  private groups: readonly WorkspaceNavigationGroup[] | undefined
  private catalog: CloudAgentCatalog | null | undefined
  private readonly listeners = new Set<() => void>()
  private readonly stop: () => void
  /** @param source - authorized Agent catalog, never a cross-member cache.
   * @param start - owning capability's serialized Session creation.
   */
  constructor(
    private readonly source: ObservableSnapshot<CloudAgentView>,
    private readonly start: (id: CloudAgentId) => Promise<SessionId>,
  ) {
    this.stop = source.subscribe(this.refresh)
    this.refresh()
  }
  /** @returns stable logical navigation groups, or `undefined` before the first catalog read settles. */
  getSnapshot = (): readonly WorkspaceNavigationGroup[] | undefined => this.groups
  /** @param listener - navigation observer.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Release subscriptions and cached memberships at authentication teardown. */
  dispose(): void { this.stop(); this.groups = []; this.catalog = undefined; this.listeners.clear() }
  private refresh = (): void => {
    const view = this.source.getSnapshot()
    // A failed read settles to no groups, so physical rows are not withheld indefinitely.
    const catalog = view.catalog === null && view.loading ? undefined : view.catalog
    if (catalog === this.catalog) return
    this.catalog = catalog
    if (catalog === undefined) { this.groups = undefined; notifySubscribers(this.listeners, 'Agent navigation'); return }
    if (catalog === null) { this.groups = []; notifySubscribers(this.listeners, 'Agent navigation'); return }
    const entries = new Map<CloudAgentId, { readonly title: string; readonly status: NonNullable<WorkspaceNavigationGroup['status']> }>()
    for (const record of catalog.mine) entries.set(record.id, { title: record.draft.name, status: record.deletedAt === undefined ? 'available' : 'deleted' })
    for (const usage of catalog.usage) entries.set(usage.agentId, { title: usage.name, status: usage.status === 'updated' ? 'available' : usage.status })
    this.groups = [...entries].map(([id, entry]) => ({
      key: brandString<WorkspaceNavigationGroup['key']>(`cloud-agent:${id}`), title: entry.title, status: entry.status,
      sessionIds: catalog.conversations.filter(item => item.agentId === id && item.deletedAt === undefined).map(item => item.sessionId),
      start: () => this.start(id), newSession: () => this.start(id),
    }))
    notifySubscribers(this.listeners, 'Agent navigation')
  }
}
