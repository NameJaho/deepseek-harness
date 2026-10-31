import { describe, expect, it, vi } from 'vitest'
import type { CloudAgentCatalog, CloudAgentRecord, CloudAgentRelease, CloudAgentUsageStatus } from '../src/types.ts'
import type { CloudAgentView } from '../src/client/controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentNavigationGroups } from '../src/client/navigation.ts'
import { agentMcpSelection, connectedAgent } from '../src/client/agent-mcp.ts'
import { en, zh } from '../src/client/locales.ts'

const record: CloudAgentRecord = { id: 'agent' as CloudAgentRecord['id'], ownerId: 'owner' as CloudAgentRecord['ownerId'], revision: 1,
  draft: { name: 'Stable Agent', description: 'Saved draft', instructions: 'Help', provider: 'p', model: 'm', mcpTools: ['draft.tool'] },
  releases: [], publishedReleaseId: null, createdAt: 1, updatedAt: 1 }
const old: CloudAgentRelease = { id: 'old' as CloudAgentRelease['id'], kind: 'published', version: 1, draftRevision: 1,
  definition: { ...record.draft, name: 'Pinned name', mcpTools: ['saved.missing'] }, mcpBindings: [{ name: 'saved.missing', fingerprint: 'old-fingerprint' }], createdAt: 1 }
const latest: CloudAgentRelease = { ...old, id: 'latest' as CloudAgentRelease['id'], version: 2, definition: { ...record.draft, mcpTools: ['new.tool'] } }
const session = 'usage' as SessionId
const catalog: CloudAgentCatalog = { mine: [record], published: [], usage: [], conversations: [], models: { groups: [], default: { provider: 'p', model: 'm' }, routableProviders: [], failures: [] },
  capabilities: { mcpTools: [{ name: 'unselected.global', description: 'Do not show' }], mcpServers: [], skills: [] } }
function source(initial: CloudAgentCatalog | null) {
  let view: CloudAgentView = { catalog: initial, presets: [], loading: false, busy: false, error: null, notice: null, editorRequest: null }
  const listeners = new Set<() => void>()
  return { getSnapshot: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    update: (catalog: CloudAgentCatalog | null) => { view = { ...view, catalog }; for (const listener of listeners) listener() },
    listeners }
}

describe('caller-scoped logical Agent navigation', () => {
  it.each(['available', 'updated', 'deleted', 'withdrawn', 'access-lost', 'disabled'] as CloudAgentUsageStatus[])('coalesces owned and used Agent into one stable group with status %s', async (status) => {
    const input = source({ ...catalog, usage: [{ agentId: record.id, ownerId: record.ownerId, name: 'Stable Agent', status }],
      conversations: [{ agentId: record.id, role: 'usage', sessionId: session }, { agentId: record.id, role: 'authoring', sessionId: 'editor' as SessionId },
        { agentId: record.id, role: 'usage', sessionId: 'removed' as SessionId, deletedAt: 1 }] })
    const start = vi.fn(async () => 'new-session' as SessionId)
    const groups = new AgentNavigationGroups(input, start)
    expect(groups.getSnapshot()).toHaveLength(1)
    const group = groups.getSnapshot()[0]!
    expect(group).toMatchObject({ key: 'cloud-agent:agent', title: 'Stable Agent', status: status === 'updated' ? 'available' : status, sessionIds: ['usage', 'editor'] })
    expect(await group.newSession?.()).toBe('new-session')
    expect(start).toHaveBeenCalledWith(record.id)
    groups.dispose()
    expect(groups.getSnapshot()).toEqual([])
    expect(input.listeners.size).toBe(0)
    input.update(catalog)
    expect(groups.getSnapshot()).toEqual([])
  })

  it('does not carry groups from a former member catalog into another lifecycle', () => {
    const input = source(catalog)
    const groups = new AgentNavigationGroups(input, vi.fn())
    expect(groups.getSnapshot()).toHaveLength(1)
    input.update(null)
    expect(groups.getSnapshot()).toEqual([])
    input.update({ ...catalog, mine: [], usage: [] })
    expect(groups.getSnapshot()).toEqual([])
    groups.dispose()
  })
})

describe('immutable release capability resolution', () => {
  it('shows the exact pinned release, saved names and only its selected capabilities after a newer release is published', () => {
    const input = { ...catalog, mine: [{ ...record, releases: [old, latest], publishedReleaseId: latest.id }],
      published: [{ id: record.id, ownerId: record.ownerId, release: latest }], conversations: [{ agentId: record.id, sessionId: session, role: 'usage' as const, releaseId: old.id }] }
    expect(connectedAgent(input, session)?.release).toBe(old)
    expect(agentMcpSelection(input, session, 'workspace-write')).toMatchObject({ kind: 'release', release: old, tools: [{ name: 'saved.missing', description: undefined }] })
  })

  it('never turns a foreign or minimal usage release into an editable record', () => {
    const input = { ...catalog, mine: [], published: [{ id: record.id, ownerId: record.ownerId, release: old }],
      conversations: [{ agentId: record.id, sessionId: session, role: 'usage' as const, releaseId: old.id }] }
    const selected = agentMcpSelection(input, session, 'minimal')
    expect(selected.kind).toBe('release')
    expect('record' in selected).toBe(false)
    expect(connectedAgent({ ...input, published: [{ ...input.published[0]!, release: latest }] }, session)).toBeUndefined()
  })

  it('distinguishes new authoring, unavailable and editable authoring sessions', () => {
    const input = { ...catalog, conversations: [{ agentId: record.id, sessionId: session, role: 'authoring' as const }] }
    expect(agentMcpSelection(input, session, 'authoring')).toMatchObject({ kind: 'draft', tools: [{ name: 'draft.tool' }] })
    expect(agentMcpSelection(input, session, 'minimal')).toEqual({ kind: 'unavailable' })
    expect(agentMcpSelection({ ...input, conversations: [{ ...input.conversations[0]!, agentId: null }] }, session)).toEqual({ kind: 'new' })
  })
})

describe('bilingual Phase 2 copy', () => {
  it('covers exactly the same nonempty keys and interpolation fields', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(en[key].trim()).not.toBe('')
      expect(zh[key].trim()).not.toBe('')
      expect(en[key].match(/\{\w+\}/g)?.sort() ?? []).toEqual(zh[key].match(/\{\w+\}/g)?.sort() ?? [])
    }
    expect(Object.keys(en).join(' ')).not.toMatch(/credential|endpoint|token|knowledge|codeExecution|html/i)
  })
})
