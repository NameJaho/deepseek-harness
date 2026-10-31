/** Real local direct retrieval, permission isolation and cancellation for the knowledge service. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { WecomUserPrincipal } from '@deepseek-ai/dsh-company-wecom-auth/types'
import { describe, expect, it, vi } from 'vitest'
import type { TestContext } from 'vitest'
import Knowledge, { Config } from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'knowledge-test-member': { readonly kind: 'knowledge-test-member' } }
}

type Answer = (request: IncomingMessage, body: string, response: ServerResponse) => void

async function server(test: TestContext, answer: Answer): Promise<string> {
  const instance = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => { answer(request, body, response) })
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  test.onTestFinished(() => new Promise<void>((resolve, reject) => {
    instance.closeAllConnections()
    instance.close((error) => { if (error === undefined) resolve(); else reject(error) })
  }))
  const address = instance.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port')
  return `http://127.0.0.1:${String(address.port)}/search`
}

const json = (value: object): Answer => (_request, _body, response) => {
  response.setHeader('content-type', 'application/json')
  const legacy = value as { results?: unknown; total_hits?: unknown }
  const body = Array.isArray(legacy.results) ? {
    query: 'question', signals: { per_source: { chunks: { hits: typeof legacy.total_hits === 'number' ? legacy.total_hits : legacy.results.length } } },
    results: { chunks: legacy.results, images: [], im: [], graph: [] },
  } : value
  response.end(JSON.stringify(body))
}
async function context(test: TestContext): Promise<Context> {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

const source = (url: string, overrides: Partial<Config['sources'][number]> = {}): Config['sources'][number] => ({
  id: 'operations', name: 'Operations', description: 'Approved space', searchUrl: url, spaceIds: ['approved-space'], ...overrides,
})

async function service(test: TestContext, url: string, options: Partial<Config> = {}) {
  const ctx = await context(test)
  await ctx.plugin(Knowledge, Config({ sources: [source(url)], ...options }))
  return ctx.companyKnowledge
}

function hit(overrides: Partial<{ space_id: string; score: number; content: string; chunk_id: string }> = {}) {
  return { chunk_id: 'chunk', document_id: 'document', doc_title: 'Device manual', breadcrumb: 'Cash drawer > Troubleshooting',
    content: 'Check the printer power before inspecting the drawer cable.', score: 0.96, space_id: 'approved-space', ...overrides }
}

const signal = () => new AbortController().signal
const ask = { sourceId: 'operations', query: 'question' }

describe('approved knowledge search', () => {
  it('sends the direct retrieve request and preserves method and sufficiency signals', async (test) => {
    const received: string[] = []
    const url = await server(test, (request, body, response) => {
      received.push(body)
      json({
        query: 'still not working', rewritten: 'printer remains out of paper after reload', same_topic: true,
        locked_method_id: 'im_cc344d1020cb', verified: true, sufficient: true, missing: '', conflicts: [],
        signals: { method: { knowledge_id: 'im_cc344d1020cb', current_step: 2 }, per_source: { chunks: { hits: 1 } } },
        reply_strategy: { do: ['give one step'] }, references: [{ lineage: ['operations'] }], activity: { elapsed_ms: 10 },
        results: { chunks: [hit()], images: [{ image_id: 'image-1' }], im: [{ chunk_id: 'im_cc344d1020cb' }], graph: [] },
      })(request, body, response)
    })
    const api = await service(test, url)
    const result = await api.search(api.binding('operations'), '还是不行', signal(), {
      messages: [{ role: 'user', content: '打印机不出纸' }, { role: 'assistant', content: '重新装纸' }, { role: 'user', content: '还是不行' }],
      emotion: '不满', prevMethodId: 'im_cc344d1020cb', verify: true, image: 'https://img.example/photo.png', kbIds: ['kb-1'],
      sources: ['chunks', 'im'], topK: 3, filterDocType: 'qa', excludeNeedsReview: true,
    })
    expect(JSON.parse(received[0] ?? '')).toEqual({ messages: [
      { role: 'user', content: '打印机不出纸' }, { role: 'assistant', content: '重新装纸' }, { role: 'user', content: '还是不行' },
    ], space_ids: ['approved-space'], emotion: '不满', prev_method_id: 'im_cc344d1020cb', verify: true,
    image: 'https://img.example/photo.png', kb_ids: ['kb-1'], sources: ['chunks', 'im'], top_k: 3,
    filter_doc_type: 'qa', exclude_needs_review: true })
    expect(result.retrieve).toMatchObject({ rewritten: 'printer remains out of paper after reload', sameTopic: true,
      lockedMethodId: 'im_cc344d1020cb', verified: true, sufficient: true, signals: { method: { knowledge_id: 'im_cc344d1020cb' } } })
    expect(result.hits).toHaveLength(1)
  })

  it('injects only approved spaces, preserves full content, filters weak or empty passages and removes duplicates', async (test) => {
    const received: string[] = []
    const url = await server(test, (request, body, response) => {
      received.push(body)
      json({ results: [hit(), hit({ chunk_id: 'duplicate' }), hit({ chunk_id: 'weak', content: 'Unrelated text', score: 0.26 }),
        hit({ chunk_id: 'blank', content: '   ' })], total_hits: 9 })(request, body, response)
    })
    const api = await service(test, url)
    const catalog = await api.catalog()
    expect(catalog).toEqual({ sources: [{ id: 'operations', name: 'Operations', description: 'Approved space' }], maxQueryChars: 16000 })
    expect(JSON.stringify(catalog)).not.toContain('approved-space')
    const result = await api.test({ sourceId: 'operations', query: '  钱箱打不开怎么办  ' }, signal())
    expect(JSON.parse(received[0] ?? '')).toEqual({ messages: [{ role: 'user', content: '钱箱打不开怎么办' }], space_ids: ['approved-space'] })
    expect(result).toMatchObject({ sourceId: 'operations', returned: 4, totalHits: 9, belowThreshold: 1, hits: [{
      chunkId: 'chunk', documentId: 'document', documentTitle: 'Device manual', breadcrumb: 'Cash drawer > Troubleshooting',
      content: hit().content, score: 0.96 }] })
  })

  it('returns an empty result when no passage meets the threshold', async (test) => {
    const url = await server(test, json({ results: [hit({ score: 0.1 })], total_hits: 1 }))
    const api = await service(test, url)
    expect(await api.test(ask, signal())).toMatchObject({ hits: [], returned: 1, belowThreshold: 1 })
  })

  it.for([
    ['a passage from a space outside the source', json({ results: [hit({ space_id: 'other' })], total_hits: 1 })],
    ['a score outside 0 to 1', json({ results: [hit({ score: 1.5 })], total_hits: 1 })],
    ['a body that is not JSON', ((_request, _body, response) => { response.end('<html>') }) satisfies Answer],
    ['a response without a body', ((_request, _body, response) => { response.writeHead(204); response.end() }) satisfies Answer],
    ['a body that is not UTF-8', ((_request, _body, response) => { response.end(Buffer.from([0xff, 0xfe, 0xfd])) }) satisfies Answer],
  ] as const)('rejects %s as an invalid response', async ([, answer], test) => {
    const url = await server(test, answer)
    const api = await service(test, url, { topK: 1 })
    await expect(api.test(ask, signal())).rejects.toMatchObject({ code: 'company-knowledge/search-failed', details: { reason: 'response' } })
  })

  it('rejects an oversized response without returning partial evidence', async (test) => {
    const url = await server(test, json({ results: [hit()], total_hits: 1 }))
    const api = await service(test, url, { maxResponseBytes: 32 })
    await expect(api.test(ask, signal())).rejects.toMatchObject({ code: 'company-knowledge/search-failed', details: { reason: 'response' } })
  })

  it('reports an upstream HTTP failure with its status but not its body', async (test) => {
    const url = await server(test, (_request, _body, response) => { response.writeHead(503); response.end('private upstream details') })
    const api = await service(test, url)
    const failure = await api.test(ask, signal()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'company-knowledge/search-failed', details: { reason: 'http', status: 503 } })
    expect(String(failure)).not.toContain('private upstream details')
  })

  it('reports an unreachable service as a transport failure without echoing its address', async (test) => {
    const url = await server(test, json({}))
    const api = await service(test, url.replace(/:\d+\//, ':1/'))
    const failure = await api.test(ask, signal()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'company-knowledge/search-failed', details: { reason: 'transport' } })
    expect(String(failure)).not.toContain('127.0.0.1')
  })

  it('reports a request exceeding its deadline as a timeout', async (test) => {
    const url = await server(test, () => {})
    const api = await service(test, url, { timeoutMs: 50 })
    await expect(api.test(ask, signal())).rejects.toMatchObject({ code: 'company-knowledge/search-failed', details: { reason: 'timeout' } })
  })

  it('propagates caller cancellation instead of classifying it as a search failure', async (test) => {
    const entered = Promise.withResolvers<undefined>()
    const url = await server(test, () => { entered.resolve(undefined) })
    const api = await service(test, url)
    const controller = new AbortController()
    const pending = api.test(ask, controller.signal)
    await entered.promise
    controller.abort(new Error('caller left'))
    await expect(pending).rejects.toThrow('caller left')
  })

  it('cancels an admitted request before service disposal completes', async (test) => {
    const entered = Promise.withResolvers<undefined>()
    const url = await server(test, () => { entered.resolve(undefined) })
    const ctx = await context(test)
    const fiber = await ctx.plugin(Knowledge, Config({ sources: [source(url)] }))
    const api = ctx.companyKnowledge
    const pending = api.test(ask, signal())
    const settled = vi.fn()
    void pending.then(settled, settled)
    await entered.promise
    await fiber.dispose()
    expect(settled).toHaveBeenCalledOnce()
    await expect(pending).rejects.toThrow('Knowledge search service stopped')
    await expect(api.search(api.binding('operations'), 'question', signal()))
      .rejects.toMatchObject({ code: 'company-knowledge/unavailable' })
  })

  it.for([['an empty', '   '], ['an overlong', 'x'.repeat(9)]] as const)('rejects %s question before making a request', async ([, query], test) => {
    let calls = 0
    const url = await server(test, (request, body, response) => { calls++; json({ results: [], total_hits: 0 })(request, body, response) })
    const api = await service(test, url, { maxQueryChars: 8 })
    await expect(api.test({ sourceId: 'operations', query }, signal()))
      .rejects.toMatchObject({ code: 'company-knowledge/invalid-input', details: { field: 'query' } })
    expect(calls).toBe(0)
  })

  it('rejects an unknown source', async (test) => {
    const api = await service(test, await server(test, json({})))
    await expect(api.test({ sourceId: 'missing', query: 'question' }, signal()))
      .rejects.toMatchObject({ code: 'company-knowledge/not-found', details: { sourceId: 'missing' } })
  })
})

describe('release bindings', () => {
  it('fingerprints the space set independent of order and duplicates', async (test) => {
    const url = await server(test, json({}))
    const ctx = await context(test)
    await ctx.plugin(Knowledge, Config({ sources: [source(url, { spaceIds: ['b', 'a', 'b'] }), source(url, { id: 'mirror', spaceIds: ['a', 'b'] })] }))
    expect(ctx.companyKnowledge.binding('operations').fingerprint).toBe(ctx.companyKnowledge.binding('mirror').fingerprint)
    expect(ctx.companyKnowledge.sources().map(item => item.id)).toEqual(['operations', 'mirror'])
  })

  it('rejects a changed permission fingerprint before making a request', async (test) => {
    let calls = 0
    const url = await server(test, (_request, _body, response) => { calls++; response.end('{}') })
    const api = await service(test, url)
    const changed = { id: 'operations', fingerprint: 'changed' }
    expect(() => { api.validate(changed) }).toThrow(expect.objectContaining({ code: 'company-knowledge/binding-changed' }) as Error)
    await expect(api.search(changed, 'question', signal())).rejects.toMatchObject({ code: 'company-knowledge/binding-changed' })
    expect(calls).toBe(0)
    expect(() => { api.validate(api.binding('operations')) }).not.toThrow()
  })
})

describe('configuration and access', () => {
  it.for([
    ['an unparsable URL', [source('not a url')], 'invalid searchUrl'],
    ['a non-HTTP URL', [source('file:///etc/passwd')], 'HTTP searchUrl'],
    ['embedded credentials', [source('https://user:secret@knowledge.example/search')], 'HTTP searchUrl'],
    ['duplicate ids', [source('https://knowledge.example/a'), source('https://knowledge.example/b')], 'duplicated'],
  ] as const)('fails at load for %s without echoing the URL', async ([, sources, message], test) => {
    const ctx = await context(test)
    const loading = Promise.resolve(ctx.plugin(Knowledge, Config({ sources: [...sources] })))
    const failure = await loading.then(() => undefined, (error: unknown) => error)
    expect(String(failure)).toContain(message)
    expect(String(failure)).not.toContain('secret')
  })

  it('accepts an empty source list as the unconfigured state', async (test) => {
    const ctx = await context(test)
    await ctx.plugin(Knowledge, Config({}))
    expect(await ctx.companyKnowledge.catalog()).toEqual({ sources: [], maxQueryChars: 16000 })
  })

  it('limits Remote management to company members and the deployment owner', async (test) => {
    const url = await server(test, json({ results: [], total_hits: 0 }))
    const ctx = await context(test)
    await ctx.plugin(Knowledge, Config({ sources: [source(url)] }))
    const invoke = (principal: RemoteInvocation['peer']['principal']) => {
      const abort = signal()
      const invocation: RemoteInvocation = { request: { namespace: 'companyKnowledge', method: 'catalog', args: {} },
        service: 'companyKnowledge', signal: abort,
        peer: { id: brandString<RemoteInvocation['peer']['id']>('peer'), ctx, principal, interactions: 'answer', signal: abort,
          dispose: () => Promise.resolve() },
        uplink: <In>(): AsyncIterable<In> => ({
          [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
        }),
      }
      return ctx.extend({ invocation }).companyKnowledge
    }
    await expect(invoke({ kind: 'knowledge-test-member' }).catalog()).rejects.toMatchObject({ code: 'company-knowledge/owner-required' })
    await expect(invoke({ kind: 'knowledge-test-member' }).test(ask, signal())).rejects.toMatchObject({ code: 'company-knowledge/owner-required' })
    const member: WecomUserPrincipal = { kind: 'wecom-user', identityId: brandString<WecomUserPrincipal['identityId']>('member'),
      corpId: brandString<WecomUserPrincipal['corpId']>('corp'), userId: brandString<WecomUserPrincipal['userId']>('member'), role: 'user' }
    expect((await invoke(member).catalog()).sources).toHaveLength(1)
    expect((await invoke({ kind: 'owner' }).catalog()).sources).toHaveLength(1)
  })
})
