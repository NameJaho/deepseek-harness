import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceNavigationGroups } from '../src/client/groups.ts'
import type { WorkspaceNavigationGroup, WorkspaceNavigationGroupStatus } from '../src/client/groups.ts'

const wid = (id: string) => id as WorkspaceId
const workspace = (id: string, sessions: string[], createdAt = '2026-10-01T00:00:00.000Z'): WorkspaceView => ({
  workspaceId: wid(id), title: id, path: `/sessions/${id}`, sessionIds: sessions.map(SessionId),
  createdAt, updatedAt: createdAt,
})
const snapshot = (items: WorkspaceView[]): WorkspaceSnapshot => ({ items, phase: 'ready', state: 'idle', error: null,
  pinnedSessionIds: [SessionId('chat')], archivedSessionIds: [SessionId('old')] })
const groupStore = (groups: readonly WorkspaceNavigationGroup[]) => createSnapshotStore<readonly WorkspaceNavigationGroup[]>(groups)

describe('capability-owned navigation groups', () => {
  it('combines versions and editing sessions by stable identity while retaining physical directories and loose sessions', () => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['chat', 'ordinary']), workspace('two', ['editor']), workspace('three', ['other'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const start = vi.fn(async () => SessionId('new-release'))
    const newSession = vi.fn(async () => SessionId('new-authoring'))
    const deletion = vi.fn(async () => {})
    const deleteConfirmation = { title: 'Delete agent', description: 'Keep existing conversations' }
    const groups = groupStore([
      { key: wid('agent:a'), title: 'Same name', sessionIds: ['chat', 'editor', 'old'].map(SessionId), start, newSession,
        delete: deletion, deleteConfirmation },
      { key: wid('agent:b'), title: 'Same name', sessionIds: [SessionId('other')], start },
    ])
    const remove = navigation.register(groups)
    const view = navigation.getSnapshot()
    expect(view.items.map(item => [item.workspaceId, item.sessionIds])).toEqual([
      ['one', ['ordinary']], ['agent:a', ['chat', 'editor', 'old']], ['agent:b', ['other']],
    ])
    expect(view.archivedSessionIds).toEqual([SessionId('old')])
    expect(view.pinnedSessionIds).toEqual([SessionId('chat')])
    expect(physical.getSnapshot().items[0]?.sessionIds).toEqual(['chat', 'ordinary'])
    expect(physical.getSnapshot().items[1]?.path).toBe('/sessions/two')
    expect(navigation.getSnapshot()).toBe(view)
    expect(navigation.start(wid('agent:a'), 'connect')).toEqual({ kind: 'capability', start })
    expect(navigation.start(wid('agent:a'), 'new-session')).toEqual({ kind: 'capability', start: newSession })
    expect(navigation.start(wid('agent:b'), 'connect')).toEqual({ kind: 'capability', start })
    expect(navigation.start(wid('agent:b'), 'new-session'))
      .toEqual({ kind: 'physical', workspace: physical.getSnapshot().items[2] })
    expect(navigation.deletion(wid('agent:a'))).toBe(deletion)
    expect(navigation.backingWorkspace(wid('agent:a'))?.workspaceId).toBe('one')
    const agent = navigation.getSnapshot().items.find(item => item.workspaceId === wid('agent:a'))
    expect(agent?.navigationDelete).toBe(deletion)
    expect(agent?.navigationDeleteConfirmation).toBe(deleteConfirmation)
    remove()
    expect(navigation.getSnapshot().items).toEqual(physical.getSnapshot().items)
    expect(navigation.start(wid('agent:a'), 'connect')).toBeUndefined()
    expect(navigation.start(wid('agent:a'), 'new-session')).toBeUndefined()
    expect(navigation.deletion(wid('agent:a'))).toBeUndefined()
    expect(navigation.backingWorkspace(wid('agent:a'))).toBeUndefined()
    navigation.dispose()
  })

  it('keeps the group id across physical membership changes and withdraws observations on unload', () => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['chat']), workspace('two', ['editor'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const provider = groupStore([
      { key: wid('agent:a'), title: 'Before', sessionIds: ['chat', 'editor'].map(SessionId), start: async () => SessionId('new') },
    ])
    const unregister = navigation.register(provider)
    provider.set(provider.getSnapshot().map(group => ({ ...group, title: 'After' })))
    physical.set(snapshot([workspace('two', ['editor'])]))
    expect(navigation.getSnapshot().items.map(item => [item.workspaceId, item.title])).toEqual([['agent:a', 'After']])
    const notify = vi.fn()
    navigation.subscribe(notify)
    navigation.dispose()
    provider.set([])
    physical.set(snapshot([]))
    expect(notify).not.toHaveBeenCalled()
    unregister()
  })

  it('keeps navigation pending without rows while a provider membership is unknown', () => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['chat']), workspace('two', ['editor'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const provider = createSnapshotStore<readonly WorkspaceNavigationGroup[] | undefined>(undefined)
    const unregister = navigation.register(provider)
    expect(navigation.getSnapshot()).toMatchObject({ phase: 'pending', items: [] })
    expect(navigation.start(wid('one'), 'new-session')).toBeUndefined()
    expect(navigation.backingWorkspace(wid('one'))).toBeUndefined()
    provider.set([{ key: wid('agent:a'), title: 'Agent', sessionIds: ['chat', 'editor'].map(SessionId), start: async () => SessionId('new') }])
    expect(navigation.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ workspaceId: 'agent:a' }] })
    provider.set(undefined)
    expect(navigation.getSnapshot().items).toEqual([])
    unregister()
    expect(navigation.getSnapshot().items).toEqual(physical.getSnapshot().items)
    navigation.dispose()
  })

  it('backs a group with its earliest physical Workspace and lists a group with no listed member on its own', () => {
    const physical = createSnapshotStore(snapshot([
      workspace('late', ['b'], '2026-10-02T00:00:00.000Z'),
      workspace('early', ['a'], '2026-10-01T00:00:00.000Z'),
    ]))
    const navigation = new WorkspaceNavigationGroups(physical)
    navigation.register(groupStore([
      { key: wid('agent:a'), title: 'Split', sessionIds: ['a', 'b'].map(SessionId) },
      { key: wid('agent:elsewhere'), title: 'Elsewhere', sessionIds: [SessionId('remote')], start: async () => SessionId('n') },
      { key: wid('agent:empty'), title: 'Empty', sessionIds: [], start: async () => SessionId('n') },
    ]))
    expect(navigation.backingWorkspace(wid('agent:a'))?.workspaceId).toBe('early')
    expect(navigation.getSnapshot().items.map(item => item.workspaceId)).toEqual(['agent:a', 'agent:elsewhere'])
    const elsewhere = navigation.getSnapshot().items[1]
    expect(elsewhere?.path).toBe('')
    expect(elsewhere?.navigationStartable).toBe(true)
    expect(navigation.backingWorkspace(wid('agent:elsewhere'))).toBeUndefined()
    navigation.dispose()
  })

  it('routes a group without capability callbacks to its physical Workspace and refuses when none backs it', () => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['a'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const onlyNew = vi.fn(async () => SessionId('n'))
    navigation.register(groupStore([
      { key: wid('agent:backed'), title: 'Backed', sessionIds: [SessionId('a')] },
      { key: wid('agent:bare'), title: 'Bare', sessionIds: [SessionId('remote')] },
      { key: wid('agent:new'), title: 'Only new', sessionIds: [SessionId('remote-2')], newSession: onlyNew },
    ]))
    const backed = { kind: 'physical', workspace: physical.getSnapshot().items[0] }
    expect(navigation.start(wid('agent:backed'), 'connect')).toEqual(backed)
    expect(navigation.start(wid('agent:backed'), 'new-session')).toEqual(backed)
    expect(navigation.start(wid('agent:bare'), 'connect')).toEqual({ kind: 'unavailable' })
    expect(navigation.start(wid('agent:bare'), 'new-session')).toEqual({ kind: 'unavailable' })
    expect(navigation.start(wid('agent:new'), 'connect')).toEqual({ kind: 'capability', start: onlyNew })
    const startable = Object.fromEntries(navigation.getSnapshot().items.map(item => [item.workspaceId, item.navigationStartable]))
    expect(startable).toEqual({ 'agent:backed': true, 'agent:bare': false, 'agent:new': true })
    navigation.dispose()
  })

  it.each<WorkspaceNavigationGroupStatus>(['withdrawn', 'deleted', 'access-lost', 'disabled'])('refuses every start route for a %s group while keeping its Sessions listed', (status) => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['a'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const start = vi.fn(async () => SessionId('n'))
    const provider = groupStore([{ key: wid('agent:a'), title: 'Agent', sessionIds: [SessionId('a')], start, newSession: start, status }])
    navigation.register(provider)
    expect(navigation.start(wid('agent:a'), 'connect')).toEqual({ kind: 'unavailable' })
    expect(navigation.start(wid('agent:a'), 'new-session')).toEqual({ kind: 'unavailable' })
    expect(navigation.getSnapshot().items).toMatchObject([
      { workspaceId: 'agent:a', sessionIds: ['a'], navigationStatus: status, navigationStartable: false },
    ])
    provider.set([{ key: wid('agent:a'), title: 'Agent', sessionIds: [SessionId('a')], start, status: 'available' }])
    expect(navigation.start(wid('agent:a'), 'connect')).toEqual({ kind: 'capability', start })
    expect(navigation.getSnapshot().items[0]?.navigationStartable).toBe(true)
    navigation.dispose()
  })

  it('reports an available status when a group omits it', () => {
    const navigation = new WorkspaceNavigationGroups(createSnapshotStore(snapshot([workspace('one', ['a'])])))
    navigation.register(groupStore([{ key: wid('agent:a'), title: 'Agent', sessionIds: [SessionId('a')] }]))
    expect(navigation.getSnapshot().items[0]?.navigationStatus).toBe('available')
    navigation.dispose()
  })

  it('refuses a provider registered twice, a repeated key and a Session owned by two groups, restoring the previous projection', () => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['a'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const first = groupStore([{ key: wid('agent:a'), title: 'Agent', sessionIds: [SessionId('a')] }])
    navigation.register(first)
    expect(() => navigation.register(first)).toThrow('already registered')
    const before = navigation.getSnapshot().items
    expect(() => navigation.register(groupStore([{ key: wid('agent:a'), title: 'Twin', sessionIds: [] }])))
      .toThrow('contributed more than once')
    expect(() => navigation.register(groupStore([{ key: wid('agent:b'), title: 'Other', sessionIds: [SessionId('a')] }])))
      .toThrow('belongs to multiple navigation groups')
    expect(navigation.getSnapshot().items).toEqual(before)
    navigation.dispose()
  })

  it('treats a repeated disposer as a no-op and notifies observers until they unsubscribe', () => {
    const physical = createSnapshotStore(snapshot([workspace('one', ['a'])]))
    const navigation = new WorkspaceNavigationGroups(physical)
    const notify = vi.fn()
    const unsubscribe = navigation.subscribe(notify)
    const remove = navigation.register(groupStore([{ key: wid('agent:a'), title: 'Agent', sessionIds: [SessionId('a')] }]))
    expect(notify).toHaveBeenCalledTimes(1)
    remove()
    expect(notify).toHaveBeenCalledTimes(2)
    remove()
    expect(notify).toHaveBeenCalledTimes(2)
    unsubscribe()
    physical.set(snapshot([]))
    expect(notify).toHaveBeenCalledTimes(2)
    navigation.dispose()
  })
})
