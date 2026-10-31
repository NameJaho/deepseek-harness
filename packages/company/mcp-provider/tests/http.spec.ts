/** HTTP gateway adapter behavior against a stubbed external MCP interface. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import HttpCompanyMcpProvider, { Config } from '../src/http.ts'
import { companyMcpToolName } from '../src/provider.ts'
import type { CompanyMcpId } from '../src/types.ts'

const TOKEN = 'PRIVATE_GATEWAY_TOKEN'
const rawConfig: Readonly<Config> = { catalogUrl: 'https://gateway.example/private/catalog', invokeUrl: 'https://gateway.example/private/invoke',
  tokenRef: 'DSH_COMPANY_MCP_TOKEN', catalogTimeoutMs: 200, callTimeoutMs: 200,
  maxCatalogBytes: 2 * 1024 * 1024, maxResultBytes: 1024 * 1024 }
const config = Config(rawConfig)
const crm = brandString<CompanyMcpId>('crm')
const lookup = companyMcpToolName(crm, 'lookup')
const server = (overrides: object = {}) => ({ id: 'crm', name: 'CRM', description: 'Customer records', status: 'available',
  updated_at: '2026-10-01T00:00:00Z', tools: [{ name: 'lookup', description: 'Find a customer',
    input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }], ...overrides })

afterEach(() => { vi.unstubAllGlobals() })

function gateway() {
  const state: {
    catalog: unknown
    invoke: unknown
    fail: 'network' | 'hang' | number | undefined
    requests: Array<{ url: string; init: RequestInit | undefined }>
  } = { catalog: { servers: [server()] },
    invoke: { status: 'ok', content: [{ type: 'text', text: 'found' }] }, fail: undefined, requests: [] }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    state.requests.push({ url: String(input), init })
    if (state.fail === 'network') throw new TypeError(`connect ECONNREFUSED ${String(input)}`)
    if (state.fail === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted', { cause: init.signal?.reason })) }, { once: true })
      })
    }
    if (typeof state.fail === 'number') return new Response('private upstream body', { status: state.fail })
    return Response.json(String(input).endsWith('/invoke') ? state.invoke : state.catalog)
  }))
  return state
}

class FixtureCredentials extends Service {
  constructor(ctx: Context, private readonly config: { resolve: (ref: CredentialRef) => Promise<ResolvedCredential | undefined> }) { super(ctx, 'credentials') }
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> { return this.config.resolve(ref) }
}

async function fixture(token: string | null = TOKEN) {
  const upstream = gateway()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const resolve = vi.fn((ref: CredentialRef) => Promise.resolve(token === null ? undefined : { value: token, source: `env:${ref}` }))
  await ctx.plugin(FixtureCredentials, { resolve })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('test', backend)
  ctx.provide(storageBackendServiceKey('test'), backend)
  await ctx.plugin(StorageDomain, { backend: 'test' })
  await ctx.plugin(HttpCompanyMcpProvider, config)
  const changes = vi.fn()
  ctx.on('company-mcp/changed', changes)
  return { ctx, upstream, provider: ctx.companyMcpProvider, changes, resolve }
}

const codeOf = (error: unknown) => remoteErrorOf(error)?.code

it('loads servers and tools with fingerprints and sends the bearer token only upstream', async () => {
  const { provider, upstream, resolve } = await fixture()
  const catalog = await provider.catalog()
  expect(catalog.loaded).toBe(true)
  expect(catalog.servers).toMatchObject([{ id: 'crm', name: 'CRM', enabled: true, status: 'available',
    updatedAt: Date.parse('2026-10-01T00:00:00Z'), tools: [{ name: lookup, rawName: 'lookup' }] }])
  expect(catalog.servers[0]?.tools[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(new Headers(upstream.requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  expect(resolve).toHaveBeenCalledWith('DSH_COMPANY_MCP_TOKEN')
  expect(JSON.stringify(catalog)).not.toMatch(/gateway\.example|PRIVATE/)
  expect(await provider.capabilityCatalog()).toEqual([{ id: 'crm', name: 'CRM', namespace: expect.stringMatching(/^company_[a-f0-9]{12}$/) as string,
    description: 'Customer records', enabled: true, status: 'available', toolNames: [lookup] }])
})

it.each([
  ['missing fields', { servers: [{ id: 'crm', tools: [] }] }],
  ['duplicate server ids', { servers: [server(), server()] }],
  ['an unsupported schema', { servers: [server({ tools: [{ name: 'x', input_schema: { type: 'string' } }] })] }],
])('rejects a catalog with %s and keeps the previous servers', async (_name, body) => {
  const { provider, upstream } = await fixture()
  upstream.catalog = body
  const catalog = await provider.refresh()
  expect(catalog.failure?.code).toBe('company-mcp/invalid-response')
  expect(catalog.servers.map(item => item.id)).toEqual(['crm'])
  await expect(provider.discover(crm, new AbortController().signal)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/invalid-response')
})

it.each([['network', 'unreachable'], ['hang', 'timed out'], [503, 'HTTP 503']] as const)(
  'reports a %s refresh failure without echoing private data', async (fail, message) => {
    const { provider, upstream } = await fixture()
    upstream.fail = fail
    const catalog = await provider.refresh()
    expect(catalog).toMatchObject({ loaded: true, failure: { code: 'company-mcp/catalog-unavailable' } })
    expect(catalog.failure?.message).toContain(message)
    expect(JSON.stringify(catalog)).not.toMatch(/gateway\.example|PRIVATE|private upstream/)
  })

it('starts unloaded rather than empty when the gateway is unreachable', async () => {
  const upstream = gateway()
  upstream.fail = 'network'
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(FixtureCredentials, { resolve: () => Promise.resolve(undefined) })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('test', backend)
  ctx.provide(storageBackendServiceKey('test'), backend)
  await ctx.plugin(StorageDomain, { backend: 'test' })
  await ctx.plugin(HttpCompanyMcpProvider, config)
  expect(await ctx.companyMcpProvider.catalog()).toMatchObject({ loaded: false, servers: [], failure: { code: 'company-mcp/catalog-unavailable' } })
  await expect(ctx.companyMcpProvider.discoverTools(crm)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/catalog-unavailable')
})

it('persists enablement and refuses disabled or unavailable servers', async () => {
  const { provider, upstream, changes } = await fixture()
  await provider.configure({ id: crm, enabled: false })
  expect(changes).toHaveBeenCalled()
  expect((await provider.catalog()).servers[0]?.enabled).toBe(false)
  await expect(provider.resolveTool(lookup)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/disabled')
  await provider.configure({ id: crm, enabled: true })
  upstream.catalog = { servers: [server({ status: 'maintenance' })] }
  await provider.refresh()
  await expect(provider.discoverTools(crm)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/unavailable')
  await expect(provider.configure({ id: brandString<CompanyMcpId>('missing'), enabled: true }))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/not-found')
})

it('executes a resolved tool and keeps failures as failures', async () => {
  const { provider, upstream } = await fixture()
  expect(await provider.resolveTool('mcp__other__tool')).toBeUndefined()
  expect(await provider.describeTool(lookup)).toMatchObject({ serverId: 'crm', rawName: 'lookup' })
  const resolved = await provider.resolveTool(lookup)
  if (resolved === undefined) throw new Error('lookup should resolve')
  const run = (args: unknown) => resolved.tool.execute(args, { signal: new AbortController().signal } as never)
  expect(await run({ q: 'a' })).toBe('found')
  expect(JSON.parse(upstream.requests.at(-1)?.init?.body as string)).toEqual({ server_id: 'crm', tool: 'lookup', arguments: { q: 'a' } })
  upstream.invoke = { status: 'error', error: { code: 'denied', message: 'Access denied' } }
  await expect(run({ q: 'a' })).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/call-failed')
  upstream.invoke = { status: 'pending' }
  await expect(run({ q: 'a' })).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/call-failed')
  upstream.invoke = { status: 'ok', is_error: true, content: [{ type: 'text', text: 'bad input' }] }
  await expect(run({ q: 'a' })).rejects.toThrow('bad input')
  upstream.fail = 'hang'
  await expect(run({ q: 'a' })).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/call-failed')
  upstream.fail = undefined
  upstream.catalog = { servers: [server({ tools: [{ name: 'lookup', description: 'Changed', input_schema: { type: 'object' } }] })] }
  await provider.refresh()
  await expect(run({ q: 'a' })).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/tool-changed')
})

it('streams snapshots and stops requests on dispose', async () => {
  const { ctx, provider, upstream } = await fixture()
  const abort = new AbortController()
  const stream = provider.follow(abort.signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ loaded: true })
  const next = stream.next()
  await provider.configure({ id: crm, enabled: false })
  expect((await next).value).toMatchObject({ servers: [{ enabled: false }] })
  abort.abort()
  expect((await stream.next()).done).toBe(true)
  upstream.fail = 'hang'
  const pending = provider.refresh()
  await ctx.fiber.dispose()
  await expect(pending).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/stopping')
})

it('rejects non-HTTP gateway URLs at load', () => {
  expect(() => new HttpCompanyMcpProvider(new Context(), Config({ ...rawConfig, catalogUrl: 'file:///etc/catalog' })))
    .toThrow('catalogUrl must be an HTTP(S) URL')
})

it('sends no authorization when the token credential is unset', async () => {
  const { provider, upstream } = await fixture(null)
  expect((await provider.catalog()).loaded).toBe(true)
  expect(new Headers(upstream.requests[0]?.init?.headers).has('authorization')).toBe(false)
})

it('rejects a token that cannot be sent as a header without contacting the gateway', async () => {
  const { provider, upstream } = await fixture('bad token')
  const catalog = await provider.catalog()
  expect(catalog.loaded).toBe(false)
  expect(catalog.failure?.message).toBe('MCP gateway credential is not a valid token')
  expect(upstream.requests).toEqual([])
})
