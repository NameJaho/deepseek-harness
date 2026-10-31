/** Knowledge page state: retained values, failure classification, cancellation and teardown. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../src/client/index.ts'
import { KnowledgeController } from '../src/client/controller.ts'
import type { CompanyKnowledgeCatalog, CompanyKnowledgeSearchResult, KnowledgeChunkId, KnowledgeDocumentId } from '../src/types.ts'

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

const catalog: CompanyKnowledgeCatalog = { sources: [{ id: 'operations', name: 'Operations', description: 'Manuals' }], maxQueryChars: 100 }
const found: CompanyKnowledgeSearchResult = { sourceId: 'operations', returned: 1, totalHits: 1, belowThreshold: 0,
  hits: [{ chunkId: brandString<KnowledgeChunkId>('chunk'), documentId: brandString<KnowledgeDocumentId>('document'),
    documentTitle: 'Manual', breadcrumb: 'Drawer', content: 'Check power', score: 0.9 }] }
const empty: CompanyKnowledgeSearchResult = { ...found, hits: [], returned: 0, totalHits: 0 }
const request = { sourceId: 'operations', query: 'drawer' }
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
const fail = (error: RemoteFailure): Outcome<never> => ({ ok: false, error })

function setup() {
  const api = {
    catalog: vi.fn((): Promise<Outcome<CompanyKnowledgeCatalog>> => Promise.resolve(ok(catalog))),
    test: vi.fn((_request: typeof request, _signal: AbortSignal): Promise<Outcome<CompanyKnowledgeSearchResult>> =>
      Promise.resolve(ok(found))),
  }
  const controller = new KnowledgeController(api as never)
  return { api, controller, face: controller.face() }
}

describe('knowledge controller', () => {
  it('loads the catalog and notifies subscribers', async () => {
    const { controller, face } = setup()
    const listener = vi.fn()
    const unsubscribe = face.hooks.companyKnowledge.subscribe(listener)
    expect(controller.getSnapshot()).toMatchObject({ loading: true, catalog: null })
    await face.refreshKnowledge()
    expect(controller.getSnapshot()).toMatchObject({ loading: false, catalog, failure: null })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    listener.mockClear()
    await face.refreshKnowledge()
    expect(listener).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('keeps the last catalog when a reload fails and clears the failure after a successful retry', async () => {
    const { api, controller, face } = setup()
    await face.refreshKnowledge()
    api.catalog.mockResolvedValueOnce(fail(new RemoteError('company-knowledge/owner-required', 'Owner only', {})))
    await face.refreshKnowledge()
    expect(controller.getSnapshot()).toMatchObject({ catalog, failure: 'load' })
    await face.retryKnowledge()
    expect(api.catalog).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot()).toMatchObject({ catalog, failure: null })
    await controller.dispose()
  })

  it('classifies thrown Remote calls as visible load and search failures', async () => {
    const { api, controller, face } = setup()
    api.catalog.mockRejectedValueOnce(new Error('catalog transport'))
    await face.refreshKnowledge()
    expect(controller.getSnapshot()).toMatchObject({ catalog: null, failure: 'load', loading: false })
    api.test.mockRejectedValueOnce(new Error('search transport'))
    await face.testKnowledge(request)
    expect(controller.getSnapshot()).toMatchObject({ failure: 'search', searching: false, statuses: { operations: { kind: 'failed' } } })
    api.test.mockRejectedValueOnce(new RemoteError('company-knowledge/search-failed', 'Gateway', { reason: 'http', status: 502 }))
    await face.testKnowledge(request)
    expect(controller.getSnapshot().failure).toBe('search')
    await controller.dispose()
  })

  it('ignores a reload while one is active', async () => {
    const { api, controller, face } = setup()
    const first = face.refreshKnowledge()
    await face.refreshKnowledge()
    await first
    expect(api.catalog).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('records the hit count or an empty result per source', async () => {
    const { api, controller, face } = setup()
    await face.testKnowledge(request)
    expect(controller.getSnapshot()).toMatchObject({ result: { request, value: found }, lastRequest: request,
      statuses: { operations: { kind: 'found', hits: 1 } }, searching: false })
    api.test.mockResolvedValueOnce(ok(empty))
    await face.testKnowledge(request)
    expect(controller.getSnapshot().statuses).toEqual({ operations: { kind: 'empty' } })
    await controller.dispose()
  })

  it.for([
    ['timeout', new RemoteError('company-knowledge/search-failed', 'Timed out', { reason: 'timeout' })],
    ['search', new RemoteError('company-knowledge/search-failed', 'Bad gateway', { reason: 'http', status: 502 })],
    ['changed', new RemoteError('company-knowledge/binding-changed', 'Changed', { sourceId: 'operations' })],
    ['changed', new RemoteError('company-knowledge/not-found', 'Missing', { sourceId: 'operations' })],
    ['search', new RemoteError('company-knowledge/invalid-input', 'Too long', { field: 'query' })],
  ] as const)('classifies a failure as %s and keeps the previous result', async ([kind, error]) => {
    const { api, controller, face } = setup()
    await face.testKnowledge(request)
    api.test.mockResolvedValueOnce(fail(error))
    await face.testKnowledge({ sourceId: 'operations', query: 'other' })
    expect(controller.getSnapshot()).toMatchObject({ failure: kind, result: { request, value: found },
      lastRequest: { query: 'other' }, statuses: { operations: { kind: 'failed' } } })
    await controller.dispose()
  })

  it('retries the last search after a search failure and reloads the catalog after a changed source', async () => {
    const { api, controller, face } = setup()
    api.test.mockResolvedValueOnce(fail(new RemoteError('company-knowledge/search-failed', 'Down', { reason: 'transport' })))
    await face.testKnowledge(request)
    await face.retryKnowledge()
    expect(api.test).toHaveBeenLastCalledWith(request, expect.any(AbortSignal))
    expect(controller.getSnapshot()).toMatchObject({ failure: null, result: { value: found } })
    api.test.mockResolvedValueOnce(fail(new RemoteError('company-knowledge/binding-changed', 'Changed', { sourceId: 'operations' })))
    await face.testKnowledge(request)
    await face.retryKnowledge()
    expect(api.catalog).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().failure).toBe(null)
    await controller.dispose()
  })

  it('reloads the catalog on retry when no search has been made', async () => {
    const { api, controller, face } = setup()
    await face.retryKnowledge()
    expect(api.catalog).toHaveBeenCalledOnce()
    expect(api.test).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('runs one search at a time and treats a cancelled search as neither a result nor a failure', async () => {
    const { api, controller, face } = setup()
    const entered = Promise.withResolvers<AbortSignal>()
    const answer = Promise.withResolvers<Outcome<CompanyKnowledgeSearchResult>>()
    api.test.mockImplementationOnce((_request, signal) => { entered.resolve(signal); return answer.promise })
    const pending = face.testKnowledge(request)
    await face.testKnowledge(request)
    expect(api.test).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().searching).toBe(true)
    const signal = await entered.promise
    face.cancelKnowledge()
    expect(signal.aborted).toBe(true)
    answer.reject(new Error('Aborted'))
    await pending
    expect(controller.getSnapshot()).toMatchObject({ searching: false, failure: null, result: null, statuses: {} })
    face.cancelKnowledge()
    await controller.dispose()
  })

  it('ignores a failure result that arrives after cancellation', async () => {
    const { api, controller, face } = setup()
    const answer = Promise.withResolvers<Outcome<CompanyKnowledgeSearchResult>>()
    api.test.mockImplementationOnce(() => answer.promise)
    const pending = face.testKnowledge(request)
    face.cancelKnowledge()
    answer.resolve(fail(new RemoteError('company-knowledge/search-failed', 'Aborted', { reason: 'transport' })))
    await pending
    expect(controller.getSnapshot()).toMatchObject({ failure: null, result: null, statuses: {} })
    await controller.dispose()
  })

  it('aborts and drains active work on disposal and ignores later actions', async () => {
    const { api, controller, face } = setup()
    const entered = Promise.withResolvers<AbortSignal>()
    api.test.mockImplementationOnce((_request, signal) => {
      entered.resolve(signal)
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve(fail(new RemoteError('company-knowledge/unavailable', 'Stopped', {}))) })
      })
    })
    const listener = vi.fn()
    face.hooks.companyKnowledge.subscribe(listener)
    void face.testKnowledge(request)
    const signal = await entered.promise
    listener.mockClear()
    await controller.dispose()
    expect(signal.aborted).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    await face.refreshKnowledge()
    await face.testKnowledge(request)
    expect(api.catalog).not.toHaveBeenCalled()
    expect(api.test).toHaveBeenCalledOnce()
  })
})
