import { describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import type { CompanyMcpCatalog, CompanyMcpId } from '../src/types.ts'
import { McpController, type McpCatalogStream } from '../src/client/mcp-controller.ts'

const id = 'server-1' as CompanyMcpId
const catalog: CompanyMcpCatalog = { loaded: true, servers: [{ id, name: 'Search service', description: 'Search documents', enabled: true,
  status: 'available', tools: [{ name: 'search', rawName: 'search', description: 'Look up a document', parametersJson: '{}', fingerprint: 'schema-1' }] }] }
const ok = <T>(value: T) => ({ ok: true as const, value })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function stream(value: CompanyMcpCatalog, fail = false): McpCatalogStream {
  const ended = deferred<undefined>()
  return { dispose: async () => { ended.resolve(undefined) }, async *[Symbol.asyncIterator]() {
    yield { generation: 1, value, signal: new AbortController().signal, accept: vi.fn() }
    if (fail) throw new Error('Stream failed')
    await ended.promise
  } }
}
function setup() {
  const api = { refresh: vi.fn(async () => ok(catalog)), configure: vi.fn(async () => ok(catalog)),
    discover: vi.fn(async () => ok(catalog.servers[0]!.tools)) }
  const notify = vi.fn()
  const makeStream = vi.fn(() => stream(catalog))
  const controller = new McpController(api, makeStream, notify)
  controller.start()
  return { api, controller, notify, makeStream }
}

describe('sanitized MCP controller', () => {
  it('keeps the confirmed directory after refresh failure and explicitly retries', async () => {
    const { api, controller, notify } = setup()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).toBe(catalog) })
    api.refresh.mockRejectedValueOnce(new Error('Private endpoint diagnostic'))
    await controller.face().refreshMcp()
    expect(controller.getSnapshot()).toMatchObject({ catalog, busy: false, error: true })
    expect(notify).toHaveBeenLastCalledWith('mcpFailed', false)
    await controller.face().retryMcp()
    expect(controller.getSnapshot().error).toBe(false)
    expect(api.refresh).toHaveBeenCalledTimes(2)
    await controller.dispose()
  })

  it.each([false, true])('retains previous data when the provider returns a failed catalog with loaded=%s', async (loaded) => {
    const { api, controller } = setup()
    await vi.waitFor(() => { expect(controller.getSnapshot().catalog).toBe(catalog) })
    api.refresh.mockResolvedValueOnce({ ok: true, value: { loaded, servers: [], failure: 'directory unavailable' } } as never)
    await controller.face().refreshMcp()
    expect(controller.getSnapshot().catalog).toBe(catalog)
    expect(controller.getSnapshot().error).toBe(true)
    await controller.dispose()
  })

  it('prevents repeated discovery and retries the same failed operation', async () => {
    const { api, controller } = setup()
    const pending = deferred<{ ok: true; value: (typeof catalog.servers)[number]['tools'] }>()
    api.discover.mockReturnValueOnce(pending.promise)
    const first = controller.face().discoverMcp(id)
    await controller.face().discoverMcp(id)
    expect(api.discover).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().busy).toBe(true)
    pending.resolve({ ok: true, value: [] })
    await first
    expect(controller.getSnapshot().catalog?.servers[0]?.tools).toEqual([])
    api.configure.mockRejectedValueOnce(new Error('Cannot save'))
    await controller.face().configureMcp(id, false)
    await controller.face().retryMcp()
    expect(api.configure).toHaveBeenCalledTimes(2)
    expect(api.configure).toHaveBeenLastCalledWith({ id, enabled: false })
    await controller.dispose()
  })

  it('does not submit a deferred configuration after its authentication lifecycle ends', async () => {
    const { controller, api, notify } = setup()
    const configuring = controller.face().configureMcp(id, false)
    const disposed = controller.dispose()
    await Promise.all([configuring, disposed])
    expect(api.configure).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('replaces a failed stream on retry and drains pending work on disposal', async () => {
    const { controller, makeStream, api, notify } = setup()
    // The replacement supervisor fails after yielding its confirmed baseline.
    await controller.dispose()
    makeStream.mockReturnValueOnce(stream(catalog, true))
    const replacement = new McpController(api, makeStream, notify)
    replacement.start()
    await vi.waitFor(() => { expect(replacement.getSnapshot().error).toBe(true) })
    expect(replacement.getSnapshot().catalog).toBe(catalog)
    await replacement.face().retryMcp()
    expect(makeStream).toHaveBeenCalledTimes(3)
    expect(replacement.getSnapshot().error).toBe(false)
    const pending = deferred<{ ok: true; value: CompanyMcpCatalog }>()
    api.refresh.mockReturnValueOnce(pending.promise)
    const refreshing = replacement.face().refreshMcp()
    await Promise.resolve()
    const dispose = replacement.dispose()
    const calls = notify.mock.calls.length
    pending.resolve({ ok: true, value: { loaded: true, servers: [] } })
    await Promise.all([refreshing, dispose])
    expect(notify).toHaveBeenCalledTimes(calls)
    expect(replacement.getSnapshot().catalog).toEqual(catalog)
  })
})
