import { describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CloudAgentCatalog, CloudAgentRecord, CloudAgentRelease, CloudAgentUsageStatus } from '../src/types.ts'
import { CloudAgentController, type CloudAgentCatalogStream } from '../src/client/controller.ts'

const sessionId = 'authoring' as SessionId
const release: CloudAgentRelease = { id: 'release-1' as CloudAgentRelease['id'], kind: 'published', version: 1, draftRevision: 2,
  definition: { name: 'Research', description: 'Agent', instructions: 'Research carefully', provider: 'provider', model: 'model', mcpTools: ['saved.tool'] }, createdAt: 1 }
const record: CloudAgentRecord = { id: 'agent-1' as CloudAgentRecord['id'], ownerId: 'owner-1' as CloudAgentRecord['ownerId'], revision: 2,
  draft: release.definition, releases: [release], publishedReleaseId: release.id, createdAt: 1, updatedAt: 2 }
const catalog: CloudAgentCatalog = { mine: [record], published: [{ id: record.id, ownerId: record.ownerId, release }],
  usage: [], conversations: [],
  capabilities: { mcpTools: [], mcpServers: [], skills: [], knowledgeSources: [] }, models: { groups: [], default: { provider: 'provider', model: 'model' }, routableProviders: [], failures: [] } }
const ok = <T>(value: T) => ({ ok: true as const, value })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function stream(value: CloudAgentCatalog, fail = false): CloudAgentCatalogStream {
  const ended = deferred<undefined>()
  return { dispose: async () => { ended.resolve(undefined) }, async *[Symbol.asyncIterator]() {
    yield { generation: 1, value, signal: new AbortController().signal, accept: vi.fn() }
    if (fail) throw new Error('Disconnected')
    await ended.promise
  } }
}
function setup(value = catalog) {
  const api = { startAuthoring: vi.fn(async () => ok({ sessionId })),
    startSession: vi.fn(async () => ok({ sessionId: 'usage' as SessionId, releaseId: release.id })),
    publish: vi.fn(async () => ok(record)), update: vi.fn(async () => ok(record)),
    create: vi.fn(async () => ok(record)), clone: vi.fn(async () => ok(record)),
    unpublish: vi.fn(async () => ok(record)), preview: vi.fn(async () => ok({ sessionId: 'preview' as SessionId, releaseId: release.id })),
    delete: vi.fn(async () => ok(undefined)) }
  const makeStream = vi.fn(() => stream(value))
  const open = vi.fn()
  const presets = vi.fn(async () => [{ id: 'read-only' }])
  const controller = new CloudAgentController(api, makeStream, open, vi.fn(), vi.fn(async () => true), vi.fn(), presets)
  return { controller, api, makeStream, open, presets }
}

describe('Cloud Agent controller', () => {
  it('retains the catalog and presets when a refresh fails, then retries', async () => {
    const { controller, makeStream, presets } = setup()
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    expect(controller.getSnapshot().catalog).toBe(catalog)
    presets.mockRejectedValueOnce(new Error('Preset read failed'))
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    expect(controller.getSnapshot()).toMatchObject({ catalog, presets: [{ id: 'read-only' }], loading: false, error: 'readFailed' })
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    expect(makeStream).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().error).toBe(null)
    await controller.dispose()
  })

  it('retains the last successful catalog on stream failure', async () => {
    const { controller, makeStream } = setup()
    makeStream.mockReturnValueOnce(stream(catalog, true))
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    await vi.waitFor(() => { expect(controller.getSnapshot().error).toBe('readFailed') })
    expect(controller.getSnapshot().catalog).toBe(catalog)
    await controller.dispose()
  })

  it('blocks duplicate submits and forwards the exact publication revision and visibility', async () => {
    const { controller, api } = setup()
    const pending = deferred<{ ok: true; value: CloudAgentRecord }>()
    api.publish.mockReturnValueOnce(pending.promise)
    const first = controller.face().publish(record, sessionId, 'private')
    expect(controller.getSnapshot().busy).toBe(true)
    expect(await controller.face().publish(record, sessionId, 'public')).toBe(false)
    expect(api.publish).toHaveBeenCalledOnce()
    expect(api.publish).toHaveBeenCalledWith({ id: record.id, expectedRevision: record.revision, authoringSessionId: sessionId, visibility: 'private' })
    pending.resolve({ ok: true, value: record })
    expect(await first).toBe(true)
    expect(controller.getSnapshot().busy).toBe(false)
    await controller.dispose()
  })

  it('forwards run preset and model overrides and creation preset to the Host', async () => {
    const { controller, api, open } = setup()
    await controller.face().start(record.id, release.id, { runPreset: 'read-only', provider: 'other', model: 'fast' })
    expect(api.startSession).toHaveBeenCalledWith({ id: record.id, releaseId: release.id, runPreset: 'read-only', provider: 'other', model: 'fast' })
    expect(open).toHaveBeenCalledWith({ sessionId: 'usage', releaseId: release.id })
    expect(await controller.face().prepareEditor(record.id, 'authoring-preset')).toBe(sessionId)
    expect(api.startAuthoring).toHaveBeenCalledWith({ id: record.id, creationPreset: 'authoring-preset' })
    await controller.dispose()
  })

  it('keeps revision conflicts explicit without overwriting the confirmed draft', async () => {
    const { controller, api } = setup()
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    api.update.mockResolvedValueOnce({ ok: false, error: new RemoteError('cloud-agent/conflict', 'Revision changed', { currentRevision: 5 }) } as never)
    const changed = { ...record.draft, name: 'Unsaved local edits' }
    expect(await controller.face().save(record.id, 2, changed, sessionId)).toEqual({ conflictRevision: 5 })
    expect(controller.getSnapshot().catalog?.mine[0]?.draft.name).toBe('Research')
    expect(controller.getSnapshot().notice).toMatchObject({ key: 'conflict', success: false })
    await controller.dispose()
  })

  it.each(['deleted', 'withdrawn', 'access-lost', 'disabled'] as CloudAgentUsageStatus[])('refuses grouped new sessions when %s', async (status) => {
    const { controller, api } = setup({ ...catalog, mine: [], usage: [{ agentId: record.id, ownerId: record.ownerId, name: 'Stable Agent', status }] })
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    await expect(controller.startGroupedSession(record.id)).rejects.toThrow('unavailable')
    expect(api.startAuthoring).not.toHaveBeenCalled()
    expect(api.startSession).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('starts the allowed grouped release with the previous run preset without selecting a different conversation', async () => {
    const { controller, api, open } = setup({ ...catalog, mine: [], usage: [{ agentId: record.id, ownerId: record.ownerId, name: 'Stable Agent', status: 'updated', release }],
      conversations: [{ agentId: record.id, sessionId: 'previous' as SessionId, role: 'usage', releaseId: release.id, creationPreset: 'source-mode', runPreset: 'read-only' }] })
    await controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).not.toBe(null) })
    expect(await controller.startGroupedSession(record.id)).toBe('usage')
    expect(api.startSession).toHaveBeenCalledWith({ id: record.id, releaseId: release.id, runPreset: 'read-only' })
    expect(open).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('drains preset refresh work before disposal completes without starting a late catalog stream', async () => {
    const { controller, presets, makeStream } = setup()
    const pending = deferred<{ id: string }[]>()
    presets.mockReturnValueOnce(pending.promise)
    const refreshing = controller.refresh()
    await vi.waitFor(() => { expect(presets).toHaveBeenCalledOnce() })
    const before = controller.getSnapshot()
    const completed = vi.fn()
    const disposed = controller.dispose().then(completed)
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    pending.resolve([{ id: 'former-member-preset' }])
    await Promise.all([refreshing, disposed])
    expect(completed).toHaveBeenCalledOnce()
    expect(makeStream).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toBe(before)
  })

  it('does not issue publication after an editor response arrives during disposal', async () => {
    const { controller, api } = setup()
    const pending = deferred<{ ok: true; value: { sessionId: SessionId } }>()
    api.startAuthoring.mockReturnValueOnce(pending.promise)
    const publication = controller.face().publish(record)
    expect(api.startAuthoring).toHaveBeenCalledOnce()
    const disposed = controller.dispose()
    pending.resolve({ ok: true, value: { sessionId } })
    expect(await publication).toBe(false)
    await disposed
    expect(api.publish).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notice).toBe(null)
  })

  it('does not navigate after a clone response arrives during disposal', async () => {
    const { controller, api, open } = setup()
    const pending = deferred<{ ok: true; value: CloudAgentRecord }>()
    api.clone.mockReturnValueOnce(pending.promise)
    const cloning = controller.face().clone(record.id, release.id)
    await vi.waitFor(() => { expect(api.clone).toHaveBeenCalledOnce() })
    const disposed = controller.dispose()
    pending.resolve({ ok: true, value: record })
    await Promise.all([cloning, disposed])
    expect(open).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notice).toBe(null)
  })

  it('opens the newly created authoring Session after cloning a public release', async () => {
    const { controller, api, open } = setup()
    await controller.face().clone(record.id, release.id)
    expect(api.clone).toHaveBeenCalledWith({ id: record.id, releaseId: release.id, authoringSessionId: sessionId })
    expect(open).toHaveBeenCalledWith({ sessionId })
  })

  it('does not publish late results after disposal', async () => {
    const { controller, api, open } = setup()
    const pending = deferred<{ ok: true; value: { sessionId: SessionId; releaseId: CloudAgentRelease['id'] } }>()
    api.startSession.mockReturnValueOnce(pending.promise)
    const start = controller.face().start(record.id, release.id)
    const disposed = controller.dispose()
    pending.resolve({ ok: true, value: { sessionId, releaseId: release.id } })
    await Promise.all([start, disposed])
    expect(open).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notice).toBe(null)
  })
})
