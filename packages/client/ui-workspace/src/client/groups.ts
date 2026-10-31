/** Capability-owned navigation groups over independently stored Workspace directories. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Whether a logical group still accepts new conversations: `available` starts them, and every
 * other state is an explicit unavailable reason the sidebar labels while keeping existing members.
 */
export type WorkspaceNavigationGroupStatus = 'available' | 'withdrawn' | 'deleted' | 'access-lost' | 'disabled'

/** Browser-only rows; a navigation group id never names a physical Workspace resource. */
export type NavigationWorkspaceView = WorkspaceView & {
  readonly navigationGroup?: string
  /** The group's availability; present only on navigation group rows. */
  readonly navigationStatus?: WorkspaceNavigationGroupStatus
  /** Whether a new conversation can start in the group; present only on navigation group rows. */
  readonly navigationStartable?: boolean
  readonly navigationDelete?: (() => Promise<void>) | undefined
  readonly navigationDeleteConfirmation?: WorkspaceNavigationGroup['deleteConfirmation']
}
/** Navigation rows with the physical registry's shared loading, pin and archive state. */
export type NavigationWorkspaceSnapshot = Omit<WorkspaceSnapshot, 'items'> & { readonly items: readonly NavigationWorkspaceView[] }

/** One logical group; its key and Session membership are owned by the contributing capability. */
export interface WorkspaceNavigationGroup {
  /** Stable logical id; never a physical Workspace id. */
  readonly key: WorkspaceId
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  /**
   * Start or reconnect through the owning capability rather than using a directory's default preset;
   * omission creates a standard Session in the physical Workspace holding the group's earliest member.
   */
  readonly start?: () => Promise<SessionId>
  /**
   * Start the explicit New Session action through the owning capability; omission creates a
   * standard Session in the backing physical Workspace, then falls back to start.
   */
  readonly newSession?: () => Promise<SessionId>
  /** Availability; omission means `available`. Any other state refuses new conversations. */
  readonly status?: WorkspaceNavigationGroupStatus
  /** Delete the capability-owned logical group and its underlying resources. */
  readonly delete?: () => Promise<void>
  /** Localized copy describing the resources removed by the capability-owned deletion. */
  readonly deleteConfirmation?: { readonly title: string; readonly description: string }
}

/** How a logical group currently answers a request to start a conversation. */
export type NavigationGroupStart =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'capability'; readonly start: () => Promise<SessionId> }
  | { readonly kind: 'physical'; readonly workspace: WorkspaceView }

interface ListedGroup {
  readonly group: WorkspaceNavigationGroup
  readonly backing: WorkspaceView | undefined
}

/** Maintains a navigation-only projection without changing physical Workspace membership. */
export class WorkspaceNavigationGroups {
  private readonly providers = new Map<ObservableSnapshot<readonly WorkspaceNavigationGroup[]>, () => void>()
  private readonly listeners = new Set<() => void>()
  private snapshot: NavigationWorkspaceSnapshot
  private readonly listed = new Map<WorkspaceId, ListedGroup>()
  private readonly stop: () => void
  /** @param source - authoritative physical Workspace snapshot. */
  constructor(private readonly source: ObservableSnapshot<WorkspaceSnapshot>) {
    this.snapshot = source.getSnapshot()
    this.stop = source.subscribe(this.refresh)
  }
  /** Read the stable navigation projection.
   * @returns projected rows and physical loading, pin and archive state.
   */
  getSnapshot = (): NavigationWorkspaceSnapshot => this.snapshot
  /** Observe navigation changes.
   * @param listener - snapshot observer.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** Contribute groups for one capability's lifetime.
   * @param provider - reactive groups.
   * @returns registration disposer, restoring physical rows.
   */
  register(provider: ObservableSnapshot<readonly WorkspaceNavigationGroup[]>): () => void {
    if (this.providers.has(provider)) throw new Error('Navigation group provider is already registered')
    const stop = provider.subscribe(this.refresh)
    this.providers.set(provider, stop)
    try {
      this.refresh()
    } catch (error: unknown) {
      stop()
      this.providers.delete(provider)
      this.refresh()
      throw error
    }
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      stop()
      this.providers.delete(provider)
      this.refresh()
    }
  }
  /** Resolve how a listed logical group starts a conversation.
   * @param workspaceId - logical navigation id.
   * @param purpose - a reconnect or an explicit New Session request.
   * @returns the start route, or undefined when the id names no listed group.
   */
  start(workspaceId: WorkspaceId, purpose: 'connect' | 'new-session'): NavigationGroupStart | undefined {
    const listed = this.listed.get(workspaceId)
    if (listed === undefined) return undefined
    const { group, backing } = listed
    const status = group.status ?? 'available'
    if (status !== 'available') return { kind: 'unavailable' }
    const preferred = purpose === 'new-session' ? group.newSession : group.start
    if (preferred !== undefined) return { kind: 'capability', start: preferred }
    if (backing !== undefined) return { kind: 'physical', workspace: backing }
    const fallback = group.start ?? group.newSession
    return fallback === undefined ? { kind: 'unavailable' } : { kind: 'capability', start: fallback }
  }
  /** Resolve the physical Workspace represented by a logical group.
   * @param workspaceId - logical navigation id.
   * @returns representative physical Workspace, or undefined when no member is currently listed.
   */
  backingWorkspace(workspaceId: WorkspaceId): WorkspaceView | undefined { return this.listed.get(workspaceId)?.backing }
  /** Resolve the deletion operation for a logical group.
   * @param workspaceId - logical navigation id.
   * @returns capability-owned deletion, or undefined for a physical Workspace.
   */
  deletion(workspaceId: WorkspaceId): NonNullable<WorkspaceNavigationGroup['delete']> | undefined {
    return this.listed.get(workspaceId)?.group.delete
  }
  /** Detach all upstream observations. */
  dispose(): void {
    this.stop()
    for (const stop of this.providers.values()) stop()
    this.providers.clear()
    this.listeners.clear()
  }
  private refresh = (): void => {
    const snapshot = this.source.getSnapshot()
    const owners = new Map<SessionId, WorkspaceNavigationGroup>()
    const groups = [...this.providers.keys()].flatMap(provider => [...provider.getSnapshot()])
    const keys = new Set<WorkspaceId>()
    for (const group of groups) {
      if (keys.has(group.key)) throw new Error(`Navigation group ${group.key} is contributed more than once`)
      keys.add(group.key)
      for (const id of group.sessionIds) {
        if (owners.has(id)) throw new Error(`Session ${id} belongs to multiple navigation groups`)
        owners.set(id, group)
      }
    }
    const representatives = new Map<WorkspaceNavigationGroup, WorkspaceView>()
    for (const workspace of snapshot.items.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      for (const id of workspace.sessionIds) {
        const group = owners.get(id)
        if (group !== undefined && !representatives.has(group)) representatives.set(group, workspace)
      }
    }
    this.listed.clear()
    const items: NavigationWorkspaceView[] = []
    const emitted = new Set<WorkspaceNavigationGroup>()
    for (const workspace of snapshot.items) {
      const managed = new Set(workspace.sessionIds.flatMap(id => owners.get(id) ?? []))
      const ordinary = workspace.sessionIds.filter(id => !owners.has(id))
      if (managed.size === 0 || ordinary.length > 0) items.push({ ...workspace, sessionIds: ordinary })
      for (const group of managed) {
        if (emitted.has(group)) continue
        const representative = representatives.get(group)
        /* v8 ignore next -- every group owning a listed member has a representative from the same listing. */
        if (representative === undefined) continue
        emitted.add(group)
        this.listed.set(group.key, { group, backing: representative })
        items.push({ ...representative, ...groupFields(group, representative) })
      }
    }
    for (const group of groups) {
      if (emitted.has(group) || group.sessionIds.length === 0) continue
      this.listed.set(group.key, { group, backing: undefined })
      const epoch = new Date(0).toISOString()
      items.push({ path: '', createdAt: epoch, updatedAt: epoch, ...groupFields(group, undefined) })
    }
    this.snapshot = { ...snapshot, items }
    notifySubscribers(this.listeners, 'workspace navigation groups')
  }
}

/** The fields a logical group contributes over its representative row. */
function groupFields(
  group: WorkspaceNavigationGroup,
  backing: WorkspaceView | undefined,
): Omit<NavigationWorkspaceView, 'path' | 'createdAt' | 'updatedAt'> {
  const status = group.status ?? 'available'
  return {
    workspaceId: group.key,
    title: group.title,
    sessionIds: group.sessionIds,
    navigationGroup: group.key,
    navigationStatus: status,
    navigationStartable: status === 'available'
      && (group.start !== undefined || group.newSession !== undefined || backing !== undefined),
    ...group.delete === undefined ? {} : { navigationDelete: group.delete },
    ...group.deleteConfirmation === undefined ? {} : { navigationDeleteConfirmation: group.deleteConfirmation },
  }
}
