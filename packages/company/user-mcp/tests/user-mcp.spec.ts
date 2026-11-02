/** Real Agent loop against local catalog, token-exchange and user MCP endpoints. */
import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RemoteError, type PeerId, type Principal, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { Client } from '@modelcontextprotocol/client'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import CompanyUserMcpService, { Config } from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test member carrying the platform user id. */
    'user-mcp-test': { readonly kind: 'user-mcp-test'; readonly userId: string }
    /** Test caller without a platform user id. */
    'user-mcp-guest': { readonly kind: 'user-mcp-guest' }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-mcp-test': { kind: 'user-mcp-test'; principal?: Principal } & ContextFormed
  }
}

const LIST_KEY = 'list-key'
const SECRET = 'platform-secret'
const PLATFORM = 'dsh-test'

interface CatalogRecord {
  mcpServiceId?: number
  name: string
  displayName?: string
  description?: string
  accessType?: string
}

type CatalogMode = 'ok' | 'failed' | 'no-data' | 'invalid'
type HoldKind = 'catalog' | 'exchange' | 'server'

interface Hold {
  readonly arrived: Promise<undefined>
  release(): void
}

function toolName(mcpName: string, tool: string): string {
  const digest = createHash('sha256').update(mcpName).digest('hex').slice(0, 8)
  return `mcp__${mcpName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 23)}_${digest}__${tool}`
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

/** One HTTP server hosting the catalog MCP, the exchange endpoint and every user MCP. */
async function startPlatform() {
  const catalogs = new Map<string, CatalogRecord[]>()
  const catalogCalls: Array<Record<string, unknown>> = []
  const exchanges: Array<{ user_id: string; mcp_name: string; environment: string }> = []
  const lookups: string[] = []
  const holds = new Map<HoldKind, { arrived: PromiseWithResolvers<undefined>; released: PromiseWithResolvers<undefined> }>()
  let mode: CatalogMode = 'ok'
  let origin = ''

  const waitHold = async (kind: HoldKind): Promise<void> => {
    const hold = holds.get(kind)
    if (hold === undefined) return
    hold.arrived.resolve(undefined)
    await hold.released.promise
  }

  const catalogHandler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'catalog', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.registerTool('queryUserAvailableMcp', {
      description: 'Lists a user\'s MCP servers.',
      inputSchema: z.object({ thirdUid: z.string(), accessType: z.string(), pageNo: z.number(), pageSize: z.number() }),
    }, async (args): Promise<CallToolResult> => {
      catalogCalls.push(args)
      await waitHold('catalog')
      const structuredContent = mode === 'ok'
        ? { success: true, code: '0', data: { records: catalogs.get(args.thirdUid) ?? [] } }
        : mode === 'failed' ? { success: false, code: 'E403', msg: 'denied' }
          : mode === 'no-data' ? { success: true } : { unexpected: true }
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent }
    })
    return mcp
  })

  const serverHandlers = new Map<string, ReturnType<typeof createMcpHandler>>()
  const serverHandler = (name: string) => {
    const existing = serverHandlers.get(name)
    if (existing !== undefined) return existing
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
      mcp.registerTool('lookup', { description: `Looks up ${name}.`, inputSchema: z.object({ query: z.string() }) }, async ({ query }): Promise<CallToolResult> => {
        lookups.push(`${name}:${query}`)
        return { content: [{ type: 'text', text: `${name}:${query}` }] }
      })
      return mcp
    })
    serverHandlers.set(name, handler)
    return handler
  }

  const exchange = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request)
    const header = (key: string): string => String(request.headers[key.toLowerCase()])
    const digest = createHash('sha256').update(body).digest('hex')
    const message = `${header('X-Platform-Id')}\n${header('X-Platform-Timestamp')}\n${header('X-Platform-Nonce')}\n${digest}`
    const expected = `v1=${createHmac('sha256', SECRET).update(message).digest('hex')}`
    if (header('X-Platform-Id') !== PLATFORM || header('X-Platform-Signature') !== expected) {
      response.writeHead(401).end('bad signature')
      return
    }
    const parsed = JSON.parse(body.toString('utf8')) as { user_id: string; mcp_name: string; environment: string }
    exchanges.push(parsed)
    await waitHold('exchange')
    const name = parsed.mcp_name
    if (name === 'refused') { response.writeHead(403).end('not authorized'); return }
    const resource = name === 'broken' ? `${origin}/missing` : `${origin}/servers/${name}${name === 'inventory' ? '/mcp' : ''}`
    const token = { access_token: `token-${name}`, token_type: 'Bearer', expires_in: name === 'short-lived' ? 30 : 3600, resource }
    const payload = name === 'malformed' ? {} : token
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  }

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', origin).pathname
    if (path === '/token/exchange') return exchange(request, response)
    if (path === '/catalog/mcp') {
      if (request.headers.authorization !== `Bearer ${LIST_KEY}`) { response.writeHead(401).end(); return }
      return toNodeHandler(catalogHandler)(request as NodeIncomingMessageLike, response)
    }
    const server = /^\/servers\/([^/]+)\/mcp$/.exec(path)?.[1]
    if (server === undefined) { response.writeHead(404).end(); return }
    if (request.headers.authorization !== `Bearer token-${server}`) { response.writeHead(401).end(); return }
    await waitHold('server')
    return toNodeHandler(serverHandler(server))(request as NodeIncomingMessageLike, response)
  }

  const http = createServer((request, response) => {
    route(request, response).catch((error: unknown) => { response.writeHead(500).end(String(error)) })
  })
  const listening = Promise.withResolvers<undefined>()
  http.listen(0, '127.0.0.1', () => { listening.resolve(undefined) })
  await listening.promise
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('platform fixture has no TCP address')
  origin = `http://127.0.0.1:${address.port}`
  const platform = {
    catalogs,
    catalogCalls,
    exchanges,
    lookups,
    listUrl: `${origin}/catalog/mcp`,
    exchangeUrl: `${origin}/token/exchange`,
    setMode: (next: CatalogMode) => { mode = next },
    hold: (kind: HoldKind): Hold => {
      const entry = { arrived: Promise.withResolvers<undefined>(), released: Promise.withResolvers<undefined>() }
      holds.set(kind, entry)
      return { arrived: entry.arrived.promise, release: () => { holds.delete(kind); entry.released.resolve(undefined) } }
    },
  }
  onTestFinished(async () => {
    for (const hold of holds.values()) hold.released.resolve(undefined)
    await catalogHandler.close()
    await Promise.all([...serverHandlers.values()].map(handler => handler.close()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  return platform
}

type Platform = Awaited<ReturnType<typeof startPlatform>>

function bridgeConfig(platform: Pick<Platform, 'listUrl' | 'exchangeUrl'>, overrides: Partial<Config> = {}): Config {
  return Config({
    enabled: true,
    listUrl: platform.listUrl,
    exchangeUrl: platform.exchangeUrl,
    platformId: PLATFORM,
    environment: 'test',
    listApiKeyEnv: 'USER_MCP_TEST_LIST_KEY',
    platformSecretEnv: 'USER_MCP_TEST_SECRET',
    requestTimeoutMs: 5000,
    connectionTimeoutMs: 5000,
    toolCallTimeoutMs: 5000,
    maxServers: 10,
    catalogTtlMs: 60_000,
    ...overrides,
  })
}

async function harness(platform: Platform, adapter: MockAdapter, overrides: Partial<Config> = {}) {
  vi.stubEnv('USER_MCP_TEST_LIST_KEY', LIST_KEY)
  vi.stubEnv('USER_MCP_TEST_SECRET', SECRET)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) } })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const bridge = await ctx.plugin(CompanyUserMcpService, bridgeConfig(platform, overrides))
  return { ctx, warnings, bridge }
}

function member(userId: string): Principal {
  return { kind: 'user-mcp-test', userId }
}

function prompt(text: string, principal?: Principal): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user-mcp-test', ...principal === undefined ? {} : { principal } } })
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function turn(ctx: Context, agent: Agent, message: UserMessage): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(message)
  await idle
}

const handles = new WeakMap<Agent, () => Promise<void>>()

async function createAgent(ctx: Context, id: string, seed?: readonly SessionEvent[]): Promise<Agent> {
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...seed === undefined ? {} : { seed },
  })
  handles.set(handle.agent, () => handle.dispose())
  return handle.agent
}

async function disposeAgent(agent: Agent): Promise<void> {
  await handles.get(agent)?.()
}

function requestTools(adapter: MockAdapter, index: number): string[] {
  return (adapter.requests[index]?.tools ?? []).map(tool => tool.name)
}

function invocationAs(ctx: Context, principal: Principal): Context {
  const invocation: RemoteInvocation = {
    request: { namespace: 'companyUserMcp', method: 'catalog', args: {} },
    service: 'companyUserMcp',
    peer: { id: 'user-mcp-peer' as PeerId, ctx, principal, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return ctx.extend({ invocation })
}

const STORE = toolName('store-goods', 'lookup')
const INVENTORY = toolName('inventory', 'lookup')

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('company user MCP bridge', () => {
  it('exposes authorized MCP tools to the member\'s Agent and contains each failing server', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [
      { mcpServiceId: 1, name: 'store-goods', displayName: 'Store goods', description: 'Store sales', accessType: 'open' },
      { name: 'inventory', displayName: '', accessType: 'authorized' },
      { name: 'refused', accessType: 'custom' },
      { name: 'broken' },
      { name: 'malformed' },
    ])
    const adapter = new MockAdapter([
      textResponse('ready'),
      toolCallResponse('call-1', STORE, { query: 'apples' }),
      textResponse('done'),
    ])
    const { ctx, warnings } = await harness(platform, adapter)
    const agent = await createAgent(ctx, 'golden')

    await turn(ctx, agent, prompt('hello', member('alice')))
    // The owner's follow-up still runs as the member recorded in the Session log; the TTL keeps the catalog.
    await turn(ctx, agent, prompt('look up apples'))

    expect(requestTools(adapter, 1)).toEqual(expect.arrayContaining([STORE, INVENTORY]))
    expect(requestTools(adapter, 1).filter(name => name.startsWith('mcp__'))).toHaveLength(2)
    expect(platform.lookups).toEqual(['store-goods:apples'])
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(JSON.stringify(result?.data)).toContain('store-goods:apples')
    expect(platform.catalogCalls).toEqual([{ thirdUid: 'alice', accessType: 'all', pageNo: 1, pageSize: 10 }])
    expect(platform.exchanges.map(entry => entry.mcp_name).sort()).toEqual(['broken', 'inventory', 'malformed', 'refused', 'store-goods'])
    expect(platform.exchanges.every(entry => entry.user_id === 'alice' && entry.environment === 'test')).toBe(true)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('skipped refused: Error: token exchange failed (403)'),
      expect.stringContaining('skipped malformed: Error: token exchange returned an invalid response'),
      expect.stringContaining('skipped broken:'),
    ]))
  })

  it('returns the authenticated caller\'s catalog summary without endpoints', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [
      { mcpServiceId: 7, name: 'store-goods', displayName: 'Store goods', description: 'Store sales', accessType: 'open' },
      { name: 'inventory', accessType: 'authorized' },
      { name: 'other', accessType: 'custom' },
    ])
    const { ctx } = await harness(platform, new MockAdapter([]), { maxServers: 2 })

    await expect(invocationAs(ctx, member(' alice ')).companyUserMcp.catalog()).resolves.toEqual({
      userId: 'alice',
      entries: [
        { id: '7', displayName: 'Store goods', description: 'Store sales', environment: 'test', accessType: 'open' },
        { id: 'inventory', displayName: 'inventory', description: '', environment: 'test', accessType: 'authorized' },
      ],
    })
    expect(platform.catalogCalls[0]).toMatchObject({ pageSize: 2 })
  })

  it('rejects catalog calls without a member id', async () => {
    const platform = await startPlatform()
    const { ctx } = await harness(platform, new MockAdapter([]))
    const unauthenticated = { code: 'company-user-mcp/unauthenticated' }

    await expect(ctx.companyUserMcp.catalog()).rejects.toMatchObject(unauthenticated)
    await expect(invocationAs(ctx, { kind: 'user-mcp-guest' }).companyUserMcp.catalog()).rejects.toMatchObject(unauthenticated)
    await expect(invocationAs(ctx, member('   ')).companyUserMcp.catalog()).rejects.toMatchObject(unauthenticated)
    expect(platform.catalogCalls).toEqual([])
  })

  it.each([
    ['failed', 'catalog request failed (E403): denied'],
    ['no-data', 'catalog request failed (unknown): '],
    ['invalid', 'catalog MCP returned an invalid response'],
  ] as const)('reports a %s catalog response', async (mode, cause) => {
    const platform = await startPlatform()
    platform.setMode(mode)
    const { ctx } = await harness(platform, new MockAdapter([]))

    const error = await invocationAs(ctx, member('alice')).companyUserMcp.catalog().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(RemoteError)
    expect((error as RemoteError).code).toBe('company-user-mcp/catalog-failed')
    expect(String((error as Error).cause)).toContain(cause)
  })

  it('keeps the turn running when credentials or the catalog are unavailable', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const { ctx, warnings } = await harness(platform, adapter, { catalogTtlMs: 0 })
    const agent = await createAgent(ctx, 'unavailable')

    vi.stubEnv('USER_MCP_TEST_LIST_KEY', ' ')
    await turn(ctx, agent, prompt('first', member('alice')))
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('catalog unavailable')]))
    expect(ctx.tools.get(STORE, agent)).toBeUndefined()

    vi.stubEnv('USER_MCP_TEST_LIST_KEY', LIST_KEY)
    vi.stubEnv('USER_MCP_TEST_SECRET', '')
    await turn(ctx, agent, prompt('second', member('alice')))
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('skipped store-goods: RemoteError')]))
    expect(ctx.tools.get(STORE, agent)).toBeUndefined()

    vi.stubEnv('USER_MCP_TEST_SECRET', SECRET)
    platform.setMode('failed')
    await turn(ctx, agent, prompt('third', member('alice')))
    expect(adapter.requests).toHaveLength(3)
    expect(platform.exchanges).toEqual([])
  })

  it('reconciles withdrawals, member changes, token reuse and expiry', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }, { name: 'short-lived' }])
    platform.catalogs.set('bob', [{ name: 'inventory' }])
    const adapter = new MockAdapter([textResponse('1'), textResponse('2'), textResponse('3'), textResponse('4'), textResponse('5')])
    const { ctx } = await harness(platform, adapter, { catalogTtlMs: 0 })
    const first = await createAgent(ctx, 'reconcile-1')

    await turn(ctx, first, prompt('alice joins', member('alice')))
    expect(ctx.tools.get(STORE, first)).toBeDefined()
    expect(ctx.tools.get(toolName('short-lived', 'lookup'), first)).toBeDefined()

    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    await turn(ctx, first, prompt('withdrawn'))
    expect(ctx.tools.get(STORE, first)).toBeDefined()
    expect(ctx.tools.get(toolName('short-lived', 'lookup'), first)).toBeUndefined()

    await turn(ctx, first, prompt('bob takes over', member('bob')))
    expect(ctx.tools.get(STORE, first)).toBeUndefined()
    expect(ctx.tools.get(INVENTORY, first)).toBeDefined()

    platform.catalogs.set('alice', [{ name: 'store-goods' }, { name: 'short-lived' }])
    const second = await createAgent(ctx, 'reconcile-2')
    await turn(ctx, second, prompt('alice again', member('alice')))
    expect(ctx.tools.get(STORE, second)).toBeDefined()
    // store-goods reuses its cached token; short-lived expires within the reuse margin and is exchanged again.
    expect(platform.exchanges.filter(entry => entry.mcp_name === 'inventory')).toEqual([{ user_id: 'bob', mcp_name: 'inventory', environment: 'test' }])
    expect(platform.exchanges.filter(entry => entry.mcp_name === 'store-goods')).toHaveLength(1)
    expect(platform.exchanges.filter(entry => entry.mcp_name === 'short-lived')).toHaveLength(2)

    await disposeAgent(second)
    expect(ctx.tools.get(STORE, second)).toBeUndefined()
    expect(ctx.tools.get(INVENTORY, first)).toBeDefined()
  })

  it('restores the member recorded by a resumed Session before its first new step', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const adapter = new MockAdapter([textResponse('1'), textResponse('2')])
    const { ctx } = await harness(platform, adapter)
    const original = await createAgent(ctx, 'original')
    await turn(ctx, original, prompt('alice', member('alice')))
    const history = original.session.snapshotEvents()
    await disposeAgent(original)

    const resumed = await createAgent(ctx, 'resumed', history)
    await vi.waitFor(() => { expect(ctx.tools.get(STORE, resumed)).toBeDefined() })
    await turn(ctx, resumed, prompt('owner follow-up'))
    expect(requestTools(adapter, 1)).toContain(STORE)
  })

  it('drops work for an Agent disposed while its catalog or connections are pending', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const { ctx } = await harness(platform, new MockAdapter([textResponse('never')]))

    const listing = await createAgent(ctx, 'disposed-listing')
    const catalog = platform.hold('catalog')
    listing.followup(prompt('hello', member('alice')))
    await catalog.arrived
    await disposeAgent(listing)
    catalog.release()
    await vi.waitFor(() => { expect(platform.catalogCalls.length).toBeGreaterThanOrEqual(1) })

    const connecting = await createAgent(ctx, 'disposed-connecting')
    const exchange = platform.hold('exchange')
    connecting.followup(prompt('hello', member('alice')))
    await exchange.arrived
    await disposeAgent(connecting)
    exchange.release()
    await vi.waitFor(() => { expect(platform.exchanges).toHaveLength(1) })
    expect(ctx.tools.get(STORE, connecting)).toBeUndefined()
    expect(platform.lookups).toEqual([])
  })

  it('closes a connection that completes after the bridge stops', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const { ctx, bridge } = await harness(platform, new MockAdapter([textResponse('never')]))
    const agent = await createAgent(ctx, 'stopped-bridge')

    const server = platform.hold('server')
    agent.followup(prompt('hello', member('alice')))
    await server.arrived
    const stopped = bridge.dispose()
    server.release()
    await stopped
    expect(ctx.tools.get(STORE, agent)).toBeUndefined()
  })

  it('lets a step cancel while a shared preparation continues', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const adapter = new MockAdapter([textResponse('after')])
    const { ctx } = await harness(platform, adapter)
    const agent = await createAgent(ctx, 'cancelled')

    const catalog = platform.hold('catalog')
    const idle = waitForIdle(ctx, agent)
    agent.followup(prompt('hello', member('alice')))
    await catalog.arrived
    agent.cancel({ kind: 'user' })
    await idle
    expect(adapter.requests).toHaveLength(0)
    catalog.release()
    await vi.waitFor(() => { expect(ctx.tools.get(STORE, agent)).toBeDefined() })

    await turn(ctx, agent, prompt('again'))
    expect(requestTools(adapter, 0)).toContain(STORE)
  })

  it('logs a failed preparation and tolerates failing transport closes', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const adapter = new MockAdapter([textResponse('1'), textResponse('2'), textResponse('3')])
    let failReads = true
    // oxlint-disable-next-line typescript/unbound-method -- the spy calls it with the registry instance as `this`.
    const register = SessionProjectionRegistry.prototype.register
    vi.spyOn(SessionProjectionRegistry.prototype, 'register').mockImplementation(function (this: SessionProjectionRegistry, definition) {
      const registration = register.call(this, definition)
      if (definition.key !== 'companyUserMcpPrincipal') return registration
      return Promise.resolve(registration).then(handle => ({
        ...handle,
        stateOf: (session: Session) => {
          if (failReads) throw new Error('read failed')
          return handle.stateOf(session)
        },
      }))
    })
    const { ctx, warnings } = await harness(platform, adapter)
    const agent = await createAgent(ctx, 'failing')

    await turn(ctx, agent, prompt('owner'))
    expect(warnings).toEqual(expect.arrayContaining(['company-user-mcp: preparation failed: Error: read failed']))
    failReads = false
    const anonymous = await createAgent(ctx, 'anonymous')
    await turn(ctx, anonymous, prompt('owner only'))
    await disposeAgent(anonymous)

    await turn(ctx, agent, prompt('alice', member('alice')))
    expect(ctx.tools.get(STORE, agent)).toBeDefined()
    const close = vi.spyOn(Client.prototype, 'close').mockRejectedValue(new Error('close failed'))
    await ctx.fiber.dispose()
    expect(close).toHaveBeenCalled()
  })

  it('stays inactive when disabled', async () => {
    const platform = await startPlatform()
    platform.catalogs.set('alice', [{ name: 'store-goods' }])
    const adapter = new MockAdapter([textResponse('1')])
    const { ctx } = await harness(platform, adapter, { enabled: false })
    const agent = await createAgent(ctx, 'disabled')

    await turn(ctx, agent, prompt('alice', member('alice')))
    await disposeAgent(agent)
    expect(platform.catalogCalls).toEqual([])
  })

  it.each([
    ['listUrl', 'not a url'],
    ['exchangeUrl', 'ftp://platform.example/token'],
  ] as const)('fails to load with a malformed %s', async (key, value) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const endpoints = { listUrl: 'http://127.0.0.1/catalog', exchangeUrl: 'http://127.0.0.1/token' }
    const config = bridgeConfig(endpoints, key === 'listUrl' ? { listUrl: value } : { exchangeUrl: value })
    expect(() => new CompanyUserMcpService(ctx, config)).toThrow(`company-user-mcp: ${key} must be an HTTP(S) URL`)
  })
})
