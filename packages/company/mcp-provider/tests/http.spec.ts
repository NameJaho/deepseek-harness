/** Existing Market wire formats, exact member mapping and read-only directory isolation. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import HttpCompanyMcpProvider, { Config } from '../src/http.ts'
import CompanyMcpRemote from '../src/index.ts'
import { companyMcpToolName } from '../src/provider.ts'
import type { CompanyMcpId } from '../src/types.ts'
import type { CompanyOwnerScope, CompanyMarketSubject, PortalUserId, WecomCorpId, WecomUserId, WecomMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'

const subject: WecomMarketSubject = { scope: brandString<CompanyOwnerScope>('wecom:corp:alice'),
  corpId: brandString<WecomCorpId>('corp'), sub: brandString<WecomUserId>('alice') }
const bob: WecomMarketSubject = { ...subject, scope: brandString<CompanyOwnerScope>('wecom:corp:bob'), sub: brandString<WecomUserId>('bob') }
const crm = brandString<CompanyMcpId>('10001')
const lookup = companyMcpToolName(crm, 'lookup')
const rawConfig = { baseUrl: 'https://market.example/mcp-market', corpId: 'corp', catalogTimeoutMs: 2000,
  maxCatalogBytes: 2 * 1024 * 1024, maxServers: 100, maxIdentityRecords: 100, maxTools: 100, pageSize: 100 }
const members = [{ userId: 101, thirdUid: 'alice', name: 'Alice', userStatus: '3' },
  { userId: 102, thirdUid: 'bob', name: 'Bob', userStatus: '3' }]
const servers = [{ id: 10001, name: 'crm', displayName: 'CRM', description: 'Customer records', accessStatus: 'open', authorized: false, toolCount: 1 },
  { id: 10002, name: 'finance', displayName: 'Finance', description: 'Finance records', accessStatus: 'open', authorized: true, toolCount: 1 },
  { id: 10003, name: 'shared', displayName: 'Shared', description: 'Open service', accessStatus: 'open', authorized: true, toolCount: 3 },
  { id: 10004, name: 'maintenance', displayName: 'Maintenance', description: '', accessStatus: 'refactoring', authorized: true, toolCount: 1 }]
const upstreamTool = { toolName: 'lookup', description: 'Find a customer',
  inputSchema: JSON.stringify({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }) }

afterEach(() => { vi.unstubAllGlobals() })

async function fixture(options: { loader?: boolean; config?: Partial<Config> } = {}) {
  const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = []
  const state = { revoked: new Set<string>(), tools: [upstreamTool], members: [...members],
    overrides: new Map<string, unknown>(), actor: subject as CompanyMarketSubject, queries: servers }
  const page = <T>(records: T[], body: Record<string, unknown>) => {
    const pageNum = Number(body.pageNum), pageSize = Number(body.pageSize)
    return { records: records.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: records.length, pageNum, pageSize }
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname.replace('/mcp-market/', '')
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    const body = JSON.parse(init.body) as Record<string, unknown>
    const headers = new Headers(init?.headers)
    requests.push({ path, headers, body })
    if (state.overrides.has(path)) return Response.json(state.overrides.get(path))
    let data: unknown
    switch (path) {
      case 'api/mcp/admin/user/list':
        data = page(state.members, body)
        break
      case 'api/mcp/list': {
        const viewer = JSON.parse(decodeURIComponent(headers.get('x-user-info') ?? '')) as { userId: string | number }
        if (!['alice', 'bob', 101, 102].includes(viewer.userId)) throw new Error('Expected mapped portal identity')
        data = page(state.queries, body)
        break
      }
      case 'api/internal/mcp/permission/check': {
        const service = servers.find(server => server.name === body.path)
        const member = members.find(member => member.thirdUid === body.sub)
        const allowed = !state.revoked.has(String(body.sub)) && (service?.id === 10003
          || service?.id === 10001 && body.sub === 'alice' || service?.id === 10002 && body.sub === 'bob')
        data = { allowed, reason: allowed ? 'authorized' : 'not_authorized', sub: body.sub, path: body.path,
          userId: member?.userId ?? null, mcpServiceId: service?.id ?? null }
        break
      }
      case 'api/mcp/query/by/id':
        data = { ...servers.find(server => server.id === body.id), streamableHttpUrl: 'https://private.example/mcp', integrationConfig: 'PRIVATE_CONFIG' }
        break
      case 'api/mcp/tool/list': data = state.tools; break
      default: throw new Error(`Unsupported Market route ${path}`)
    }
    return Response.json({ success: true, code: '200', data })
  }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
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
    await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/authorized.cordis.yml', import.meta.url).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } else await ctx.plugin(HttpCompanyMcpProvider, Config({ ...rawConfig, ...options.config }))
  return { ctx, provider: ctx.companyMcpProvider, requests, state }
}
const codeOf = (error: unknown) => remoteErrorOf(error)?.code

it('maps the official WeCom id to the portal account and uses only existing read APIs', async () => {
  const { provider, requests } = await fixture()
  expect(await provider.catalog(subject)).toMatchObject({ loaded: true, servers: [
    { id: '10001', name: 'CRM', toolCount: 1, tools: [] }, { id: '10003', name: 'Shared', toolCount: 3 },
  ] })
  const list = requests.find(request => request.path === 'api/mcp/list')!
  expect(JSON.parse(decodeURIComponent(list.headers.get('x-user-info')!))).toEqual({ userId: 'alice', userName: 'alice' })
  expect(list.body).toMatchObject({ accessFilter: 'all' })
  expect(list.body).not.toHaveProperty('adminPermissionCode')
  expect(requests.filter(request => request.path === 'api/internal/mcp/permission/check').every(request => request.body.sub === 'alice')).toBe(true)
  expect(requests.every(request => !request.headers.has('authorization'))).toBe(true)
  expect(requests.some(request => /authorized|invoke|grant|revoke|apply/.test(request.path))).toBe(false)
})

it('isolates two users, includes open services, and clears revoked access on refresh', async () => {
  const { provider, state } = await fixture()
  expect((await provider.catalog(subject)).servers.map(server => server.id)).toEqual(['10001', '10003'])
  expect((await provider.catalog(bob)).servers.map(server => server.id)).toEqual(['10002', '10003'])
  state.revoked.add('alice')
  expect(await provider.refresh(subject)).toMatchObject({ loaded: true, servers: [] })
  expect((await provider.catalog(bob)).servers).toHaveLength(2)
})

it('maps a trusted portal login to its exact HR account and WeCom subject', async () => {
  const { provider, requests } = await fixture()
  expect((await provider.catalog({ scope: brandString<CompanyOwnerScope>('gateway:102'), portalUserId: brandString<PortalUserId>('102'), displayName: 'Portal Bob' }))
    .servers.map(server => server.id)).toEqual(['10002', '10003'])
  expect(requests.filter(request => request.path.endsWith('permission/check')).every(request => request.body.sub === 'bob')).toBe(true)
})

it('uses the verified WeCom subject directly without an administrator HR lookup', async () => {
  const { provider, state } = await fixture()
  state.members = []
  expect((await provider.catalog(subject)).servers.map(server => server.id)).toEqual(['10001', '10003'])
})

it('paginates the member directory and MCP catalog without truncating authorized results', async () => {
  const { provider, requests } = await fixture({ config: { pageSize: 1 } })
  expect((await provider.catalog(subject)).servers.map(server => server.id)).toEqual(['10001', '10003'])
  expect(requests.filter(request => request.path === 'api/mcp/list').map(request => request.body.pageNum)).toEqual([1, 2, 3, 4])
})

it('reads string inputSchema only on explicit tool discovery and excludes connection data', async () => {
  const { provider, requests } = await fixture()
  const catalog = await provider.catalog(subject)
  expect(requests.some(request => request.path === 'api/mcp/tool/list')).toBe(false)
  const tools = await provider.discoverTools(subject, crm)
  expect(tools[0]).toMatchObject({ name: lookup, rawName: 'lookup', parametersJson: upstreamTool.inputSchema })
  expect(requests.at(-1)?.body).toEqual({ mcpServiceId: 10001 })
  expect(JSON.stringify({ catalog, tools })).not.toMatch(/private\.example|PRIVATE_CONFIG|streamableHttpUrl|integrationConfig/)
})

it('does not fetch details or tools for another member’s MCP or a revoked grant', async () => {
  const { provider, requests, state } = await fixture()
  await expect(provider.discoverTools(bob, crm)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/forbidden')
  state.revoked.add('alice')
  await expect(provider.discoverTools(subject, crm)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/forbidden')
  expect(requests.some(request => request.path === 'api/mcp/tool/list')).toBe(false)
})

it('denies a resource absent from the published visible list before querying detail', async () => {
  const { provider, requests } = await fixture()
  await expect(provider.discoverTools(subject, brandString<CompanyMcpId>('99999')))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/forbidden')
  expect(requests.some(request => request.path === 'api/mcp/query/by/id')).toBe(false)
})

it.each([
  { sub: 'bob', path: 'crm', mcpServiceId: 10001, userId: 101 },
  { sub: 'alice', path: 'other', mcpServiceId: 10001, userId: 101 },
  { sub: 'alice', path: 'crm', mcpServiceId: 10002, userId: 101 },
  { sub: 'alice', path: 'crm', mcpServiceId: 10001, userId: 102 },
])('rejects mismatched permission responses: %j', async (fields) => {
  const { provider, state } = await fixture()
  state.overrides.set('api/internal/mcp/permission/check', { success: true, code: '200',
    data: { allowed: true, reason: 'authorized', ...fields } })
  expect(await provider.catalog(subject)).toMatchObject({ loaded: false, servers: [] })
})

it('reports deferred execution without issuing any tool invocation request', async () => {
  const { provider, requests } = await fixture()
  const resolved = await provider.resolveTool(subject, lookup)
  expect(resolved).toBeDefined()
  const count = requests.length
  await expect(resolved!.tool.execute({}, { signal: new AbortController().signal } as never))
    .rejects.toSatisfy(error => codeOf(error) === 'company-mcp/call-unavailable')
  expect(requests).toHaveLength(count)
})

it('keeps the member list available when tool schemas are absent or malformed', async () => {
  const { provider, state } = await fixture()
  state.tools = [{ ...upstreamTool, inputSchema: '' }]
  expect((await provider.catalog(subject)).servers).toHaveLength(2)
  await expect(provider.discoverTools(subject, crm)).rejects.toSatisfy(error => codeOf(error) === 'company-mcp/invalid-response')
})

it.each([
  { success: false, code: '200', data: null },
  { success: true, code: '500', data: null },
  { success: true, code: '200', data: { records: [servers[0], servers[0]], total: 2, pageNum: 1, pageSize: 100 } },
])('clears the catalog on failed envelopes or duplicate records', async (response) => {
  const { provider, state } = await fixture()
  expect((await provider.catalog(subject)).servers).toHaveLength(2)
  state.overrides.set('api/mcp/list', response)
  expect(await provider.refresh(subject)).toMatchObject({ loaded: false, servers: [] })
})

it.each([{ maxCatalogBytes: 1 }, { maxServers: 1 }, { maxIdentityRecords: 1, pageSize: 1 }])('bounds complete directory reads: %j', async (config) => {
  const { provider } = await fixture({ config })
  const member = config.maxIdentityRecords === undefined ? subject
    : { scope: brandString<CompanyOwnerScope>('gateway:102'), portalUserId: brandString<PortalUserId>('102'), displayName: 'Bob' }
  expect(await provider.catalog(member)).toMatchObject({ loaded: false, servers: [] })
})

it('composes the credential-free provider and member Remote through the real Loader', async () => {
  const { ctx, state } = await fixture({ loader: true })
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect((await ctx.companyMcp.catalog()).servers.map(server => server.id)).toEqual(['10001', '10003'])
  state.actor = bob
  expect((await ctx.companyMcp.catalog()).servers.map(server => server.id)).toEqual(['10002', '10003'])
})
