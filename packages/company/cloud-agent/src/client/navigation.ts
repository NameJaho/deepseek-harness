/** Caller-scoped logical Agent groups over the existing ui-workspace navigation seam. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceNavigationGroup } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CloudAgentCatalog, CloudAgentId } from '../types.ts'
import type { CloudAgentView } from './controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One reactive provider per authenticated Agent catalog lifecycle; it persists no member state. */
export class AgentNavigationGroups implements ObservableSnapshot<readonly WorkspaceNavigationGroup[]> {
  private groups: readonly WorkspaceNavigationGroup[] = []
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
  /** @returns stable logical navigation groups. */
  getSnapshot = (): readonly WorkspaceNavigationGroup[] => this.groups
  /** @param listener - navigation observer.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Release subscriptions and cached memberships at authentication teardown. */
  dispose(): void { this.stop(); this.groups = []; this.catalog = undefined; this.listeners.clear() }
  private refresh = (): void => {
    const catalog = this.source.getSnapshot().catalog
    if (catalog === this.catalog) return
    this.catalog = catalog
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
