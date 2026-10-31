/** Authenticated Market adapter behavior against a deterministic internal API fixture. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import HttpCompanyMcpProvider, { Config } from '../src/http.ts'
import CompanyMcpRemote from '../src/index.ts'
import { companyMcpToolName } from '../src/provider.ts'
import type { CompanyMcpId } from '../src/types.ts'
import type { CompanyOwnerScope, WecomCorpId, WecomUserId, WecomMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'

const TOKEN = 'PRIVATE_MARKET_TOKEN'
const subject: WecomMarketSubject = { scope: brandString<CompanyOwnerScope>('wecom:corp:alice'), corpId: brandString<WecomCorpId>('corp'), sub: brandString<WecomUserId>('alice') }
const rawConfig: Readonly<Config> = { baseUrl: 'https://market.example/mcp-market', corpId: 'corp', tokenRef: 'DSH_MCP_MARKET_TOKEN',
  catalogTimeoutMs: 200, callTimeoutMs: 200, maxCatalogBytes: 2 * 1024 * 1024, maxResultBytes: 1024 * 1024,
  maxServers: 100, maxTools: 100, pageSize: 100 }
const config = Config(rawConfig)
const crm = brandString<CompanyMcpId>('crm')
const lookup = companyMcpToolName(crm, 'lookup')
const server = { id: 'crm', path: 'crm-service', name: 'CRM', description: 'Customer records', authorized: true, published: true, status: 'available' }
const tool = { name: 'lookup', description: 'Find a customer', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }

afterEach(() => { vi.unstubAllGlobals() })

async function fixture(options: { authorized?: boolean; changed?: boolean; loader?: boolean } = {}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const state = { authorized: options.authorized ?? true, changed: options.changed ?? false, actor: subject,
    revoked: new Set<string>(), response: new Map<string, unknown>() }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { sub: string; id?: string; path?: string; tool?: string }
    const route = new URL(input).pathname.split('/').at(-1) ?? ''
    if (state.response.has(route)) return Response.json(state.response.get(route))
    if (!state.authorized || state.revoked.has(body.sub)) return Response.json({ success: false, code: 'FORBIDDEN', data: null })
    if (String(input).endsWith('/page')) return Response.json({ success: true, code: '200', data: { records: [server], total: 1, pageNum: 1, pageSize: 100 } })
    if (String(input).endsWith('/detail')) return Response.json({ success: true, code: '200', data: { ...server, tools: [state.changed ? { ...tool, description: 'Changed' } : tool] } })
    return Response.json({ success: true, code: '200', data: { isError: false, content: [{ type: 'text', text: `called:${body.tool}` }] } })
  }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('credentials', { resolve: vi.fn((_ref: CredentialRef) => Promise.resolve({ value: TOKEN, source: 'fixture' })) })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('test', backend)
  ctx.provide(storageBackendServiceKey('test'), backend)
  await ctx.plugin(StorageDomain, { backend: 'test' })
  ctx.provide('companyWecomAuth', { marketSubject: () => state.actor, registerResourceProvider: () => async () => {} })
  if (options.loader === true) {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-company-mcp-provider/http', HttpCompanyMcpProvider],
      ['@deepseek-ai/dsh-company-mcp-provider', CompanyMcpRemote],
    ])
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      register(): never { throw new Error('Unexpected fixture module registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected fixture module job') },
      resolveSync(): never { throw new Error('Unexpected fixture synchronous resolution') },
      load(): never { throw new Error('Unexpected fixture module load') },
      import: async (specifier: string) => {
        if (!modules.has(specifier)) throw new Error(`Unexpected fixture plugin: ${specifier}`)
        return modules.get(specifier)
      },
    }
    await ctx.loader.create({ name: 'cordis:include', config: {
      path: new URL('./fixtures/authorized.cordis.yml', import.meta.url).href,
    } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } else await ctx.plugin(HttpCompanyMcpProvider, config)
  return { ctx, provider: ctx.companyMcpProvider, requests, state }
}

const codeOf = (error: unknown) => remoteErrorOf(error)?.code
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const bodyOf = (request: { init: RequestInit | undefined } | undefined): Record<string, unknown> => {
  if (typeof request?.init?.body !== 'string') return {}
  const parsed: unknown = JSON.parse(request.init.body)
  return isRecord(parsed) ? parsed : {}
}

it('sends verified identity and service credentials, then returns only authorized published MCPs', async () => {
  const { provider, requests } = await fixture()
  const catalog = await provider.catalog(subject)
  expect(catalog.loaded).toBe(true)
  expect(catalog.servers[0]).toMatchObject({ id: 'crm', name: 'CRM', tools: [{ name: lookup, rawName: 'lookup' }] })
  expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  expect(bodyOf(requests[0])).toMatchObject({ corpId: 'corp', sub: 'alice' })
})

it('clears the catalog when authorization is revoked', async () => {
  const { provider, state } = await fixture()
  expect((await provider.catalog(subject)).servers).toHaveLength(1)
  state.authorized = false
  const result = await provider.refresh(subject)
  expect(result).toMatchObject({ loaded: false, servers: [], failure: { code: 'company-mcp/forbidden' } })
})

it('keeps preferences isolated by verified member scope', async () => {
  const { provider } = await fixture()
  await provider.configure(subject, { id: crm, enabled: false })
  expect((await provider.catalog(subject)).servers[0]?.enabled).toBe(false)
  const bob: WecomMarketSubject = { scope: brandString<CompanyOwnerScope>('wecom:corp:bob'), corpId: brandString<WecomCorpId>('corp'), sub: brandString<WecomUserId>('bob') }
  expect((await provider.catalog(bob)).servers[0]?.enabled).toBe(true)
})

it('rechecks the schema and dispatches the authorized tool with the raw Market path', async () => {
  const { provider, requests, state } = await fixture()
  const resolved = await provider.resolveTool(subject, lookup)
  if (resolved === undefined) throw new Error('lookup should resolve')
  expect(await resolved.tool.execute({ q: 'a' }, { signal: new AbortController().signal, agent: { id: 'session' } } as never)).toBe('called:lookup')
  const requestBody = bodyOf(requests.at(-1))
  expect(requestBody).toMatchObject({ path: 'crm-service', tool: 'lookup' })
  expect(typeof requestBody.schemaFingerprint).toBe('string')
  state.changed = true
  await expect(resolved.tool.execute({ q: 'a' }, { signal: new AbortController().signal, agent: { id: 'session' } } as never))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/tool-changed')
})

it('uses an unknown-outcome error for a failed invocation response', async () => {
  const { provider } = await fixture()
  const resolved = await provider.resolveTool(subject, lookup)
  if (resolved === undefined) throw new Error('lookup should resolve')
  const original = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith('/invoke')) throw new TypeError('network failed')
    return original(input, init)
  }))
  await expect(resolved.tool.execute({}, { signal: new AbortController().signal, agent: { id: 'session' } } as never))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/call-outcome-unknown')
})

it('composes the HTTP provider and browser Remote through the real Loader', async () => {
  const { ctx } = await fixture({ loader: true })
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect((await ctx.companyMcp.catalog()).servers.map(item => item.id)).toEqual(['crm'])
  await ctx.companyMcp.configure({ id: crm, enabled: false })
  expect((await ctx.companyMcp.catalog()).servers[0]?.enabled).toBe(false)
})

it('denies a second member and a cross-member execution without dispatching an invocation', async () => {
  const { provider, state, requests } = await fixture()
  const aliceTool = await provider.resolveTool(subject, lookup)
  if (aliceTool === undefined) throw new Error('lookup should resolve')
  state.actor = { ...subject, scope: brandString<CompanyOwnerScope>('wecom:corp:bob'), sub: brandString<WecomUserId>('bob') }
  state.revoked.add('bob')
  expect((await provider.catalog(state.actor)).servers).toEqual([])
  expect((await provider.catalog(subject)).servers).toHaveLength(1)
  await expect(aliceTool.tool.execute({}, { signal: new AbortController().signal, agent: { id: 'bob-session' } } as never))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/forbidden')
  expect(requests.filter(request => request.url.endsWith('/invoke'))).toEqual([])
})

it('rechecks a revoked grant on an already resolved tool before invoking it', async () => {
  const { provider, state, requests } = await fixture()
  const resolved = await provider.resolveTool(subject, lookup)
  if (resolved === undefined) throw new Error('lookup should resolve')
  state.revoked.add('alice')
  await expect(resolved.tool.execute({}, { signal: new AbortController().signal, agent: { id: 'session' } } as never))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/forbidden')
  expect(requests.filter(request => request.url.endsWith('/invoke'))).toEqual([])
})

it.each([
  { success: false, code: '200', data: { records: [server], total: 1, pageNum: 1, pageSize: 100 } },
  { success: true, code: '500', data: { records: [server], total: 1, pageNum: 1, pageSize: 100 } },
  { success: true, code: '200', data: { records: [{ ...server, authorized: false }], total: 1, pageNum: 1, pageSize: 100 } },
  { success: true, code: '200', data: { records: [{ ...server, published: false }], total: 1, pageNum: 1, pageSize: 100 } },
])('clears the catalog on unsuccessful or unauthorized Market responses: %j', async (response) => {
  const { provider, state } = await fixture()
  expect((await provider.catalog(subject)).servers).toHaveLength(1)
  state.response.set('page', response)
  expect(await provider.refresh(subject)).toMatchObject({ loaded: false, servers: [] })
})
