/** Authenticated Market adapter. Catalogs and tool authority are always queried for the verified member. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-company-wecom-auth'
import type { WecomMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'
import { CompanyMcpProvider, companyMcpFingerprint, companyMcpToolName, type CompanyMcpResolvedTool } from './provider.ts'
import type { CompanyMcpCatalog, CompanyMcpId, CompanyMcpServer, CompanyMcpTool, CompanyMcpToolRoute } from './types.ts'

/** Private Market connection and resource budgets. */
export interface Config {
  /** Market root, including its context path, without a trailing API route. */
  baseUrl: string
  /** Enterprise whose WeCom subjects the Market resolves. */
  corpId: string
  /** Required reference to a service credential; missing credentials deny all requests. */
  tokenRef: string
  /** Total catalog/discovery timeout in milliseconds. */
  catalogTimeoutMs: number
  /** Invocation timeout in milliseconds; timed out calls have unknown outcomes. */
  callTimeoutMs: number
  /** Total bytes allowed across all pages and details of one catalog. */
  maxCatalogBytes: number
  /** Maximum invocation response bytes. */
  maxResultBytes: number
  /** Maximum authorized servers in one complete catalog. */
  maxServers: number
  /** Maximum tools per server. */
  maxTools: number
  /** Authorized page size, bounded by the Market's limit of 100. */
  pageSize: number
}

/** Loader validation for the opt-in Market adapter. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().required(), corpId: z.string().min(1).required(), tokenRef: z.string().min(1).required(),
  catalogTimeoutMs: z.natural().min(1).default(10_000), callTimeoutMs: z.natural().min(1).default(60_000),
  maxCatalogBytes: z.natural().min(1).default(2 * 1024 * 1024), maxResultBytes: z.natural().min(1).default(1024 * 1024),
  maxServers: z.natural().min(1).default(500), maxTools: z.natural().min(1).default(500),
  pageSize: z.natural().min(1).max(100).default(100),
})

type PreferenceKey = Branded<'company-mcp-preference-key'>
const preference = schema.object({ enabled: schema.boolean() }).strict()
const preferences = defineDomain({ name: 'company_mcp_member_preferences', version: 1,
  tables: { servers: domainTable<PreferenceKey, schema.infer<typeof preference>>(preference) } })
const text = (max: number) => schema.string().min(1).max(max)
const identity = { id: text(200), path: text(200), name: text(200), description: schema.string().max(4000),
  authorized: schema.literal(true), published: schema.literal(true), status: schema.enum(['available', 'connecting', 'failed', 'maintenance']) }
const summary = schema.object(identity)
const pageSchema = schema.object({ records: schema.array(summary), total: schema.number().int().nonnegative(),
  pageNum: schema.number().int().positive(), pageSize: schema.number().int().min(1).max(100) })
const detailSchema = schema.object({ ...identity, tools: schema.array(schema.object({
  name: text(200), description: schema.string().max(8000), inputSchema: schema.record(schema.string(), schema.unknown()),
})) })
const envelope = schema.object({ success: schema.boolean(), code: schema.string(), data: schema.unknown().optional() })
const resultSchema = schema.object({ isError: schema.boolean(), content: schema.array(schema.object({
  type: schema.literal('text'), text: schema.string(),
})) })
interface Budget { remaining: number }
interface ServerDetail { server: CompanyMcpServer; path: string }

function invalid(): RemoteError<'company-mcp/invalid-response'> {
  return new RemoteError('company-mcp/invalid-response', 'MCP Market returned invalid data; refresh or contact the administrator', { reason: 'invalid-response' })
}
function forbidden(): RemoteError<'company-mcp/forbidden'> {
  return new RemoteError('company-mcp/forbidden', 'MCP access is unavailable for this account; check your Market permissions', {})
}

/** One Host-owned adapter; requests have no shared catalog cache or shared user enablement. */
export class HttpCompanyMcpProvider extends CompanyMcpProvider {
  static inject = ['storageDomain', 'credentials', 'companyWecomAuth']
  static Config = Config
  private readonly config: Config
  private readonly baseUrl: URL
  private readonly tokenRef: CredentialRef
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private domain: Domain<typeof preferences> | undefined

  /** @param ctx - Host identity, credentials and preferences services.
   * @param config - Market origin, enterprise, credential reference and limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = Config(config)
    this.baseUrl = new URL(this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`)
    if (!['https:', 'http:'].includes(this.baseUrl.protocol) || this.baseUrl.username !== '' || this.baseUrl.password !== ''
      || this.baseUrl.search !== '' || this.baseUrl.hash !== '') throw new Error('company-mcp: baseUrl must be an HTTP(S) URL without credentials, query or fragment')
    this.tokenRef = credentialRef(this.config.tokenRef)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.operations])
      await this.domain?.close()
    }, 'company-mcp: requests and member preferences')
    ctx.companyWecomAuth.registerResourceProvider({ sessionOwner: () => undefined,
      bindings: () => [{ resource: { kind: 'global' }, role: { name: 'company:mcp', resource: 'global', actions: [
        'companyMcp/catalog', 'companyMcp/follow', 'companyMcp/refresh', 'companyMcp/configure', 'companyMcp/discover',
      ] } }],
    })
  }

  /** Open member preferences; no user directory is loaded at startup. */
  async [CompanyMcpProvider.init](): Promise<void> { this.domain = await this.ctx.storageDomain.open(preferences) }

  /** Read the current member-authorized catalog and persist no shared user state.
   * @param subject - verified member identity used for Market authorization.
   * @param signal - optional caller cancellation.
   * @returns the current catalog, or an empty catalog with a structured failure.
   */
  catalog(subject: WecomMarketSubject, signal?: AbortSignal): Promise<CompanyMcpCatalog> {
    return this.track(async () => {
      try { return { loaded: true, servers: await this.load(subject, signal), refreshedAt: Date.now() } }
      catch (error) {
        if (this.lifetime.signal.aborted) throw error
        return { loaded: false, servers: [], failure: error instanceof RemoteError ? {
          code: error.code as import('./types.ts').CompanyMcpErrorCode, message: error.message,
        } : { code: 'company-mcp/catalog-unavailable', message: 'MCP catalog is unavailable; refresh to try again' } }
      }
    })
  }

  async refresh(subject: WecomMarketSubject, signal?: AbortSignal): Promise<CompanyMcpCatalog> {
    signal?.throwIfAborted()
    return this.track(async () => {
      const catalog = await this.catalog(subject, signal)
      this.ctx.emit('company-mcp/changed')
      return catalog
    })
  }

  configure(subject: WecomMarketSubject, request: { readonly id: CompanyMcpId; readonly enabled: boolean }): Promise<CompanyMcpCatalog> {
    return this.track(async () => {
      await this.detail(subject, request.id, this.catalogSignal(), { remaining: this.config.maxCatalogBytes })
      await this.requireDomain().table('servers').put(this.key(subject, request.id), { enabled: request.enabled })
      this.ctx.emit('company-mcp/changed')
      return this.catalog(subject)
    })
  }

  discover(subject: WecomMarketSubject, id: CompanyMcpId, signal: AbortSignal): Promise<readonly CompanyMcpTool[]> {
    return this.track(async () => this.usable(await this.detail(subject, id, this.catalogSignal(signal),
      { remaining: this.config.maxCatalogBytes })).tools)
  }

  discoverTools(subject: WecomMarketSubject, id: CompanyMcpId): Promise<readonly CompanyMcpTool[]> {
    return this.discover(subject, id, this.lifetime.signal)
  }

  resolveTool(subject: WecomMarketSubject, name: string): Promise<CompanyMcpResolvedTool | undefined> {
    return this.track(async () => {
      const server = (await this.load(subject)).find(item => item.tools.some(tool => tool.name === name))
      if (server === undefined) return undefined
      const tool = this.usable({ server, path: '' }).tools.find(item => item.name === name)
      if (tool === undefined) return undefined
      const toolSchema: ToolSchema = {
        name,
        description: tool.description,
        parameters: JSON.parse(tool.parametersJson) as Record<string, unknown>,
      }
      return { schema: toolSchema, fingerprint: tool.fingerprint, tool: this.definition(subject, server.id, tool, toolSchema) }
    })
  }

  async describeTool(subject: WecomMarketSubject, name: string): Promise<CompanyMcpToolRoute | undefined> {
    const resolved = await this.resolveTool(subject, name)
    if (resolved === undefined) return undefined
    const server = (await this.load(subject)).find(item => item.tools.some(tool => tool.name === name))
    const tool = server?.tools.find(item => item.name === name)
    return server === undefined || tool === undefined ? undefined : { serverId: server.id, rawName: tool.rawName,
      description: tool.description, fingerprint: tool.fingerprint }
  }

  private requireDomain(): Domain<typeof preferences> {
    if (this.domain === undefined) throw new RemoteError('company-mcp/stopping', 'MCP provider is unavailable', {})
    return this.domain
  }
  private key(subject: WecomMarketSubject, id: CompanyMcpId): PreferenceKey {
    return brandString<PreferenceKey>(JSON.stringify([subject.scope, id]))
  }
  private checkSubject(subject: WecomMarketSubject): void {
    if (subject.corpId !== this.config.corpId || subject.sub === '' || subject.scope !== `wecom:${subject.corpId}:${subject.sub}`) throw forbidden()
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new RemoteError('company-mcp/stopping', 'MCP provider is stopping', {}))
    const pending = operation()
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }
  private catalogSignal(caller?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.config.catalogTimeoutMs),
      ...caller === undefined ? [] : [caller],
    ])
  }
  private usable(detail: ServerDetail): CompanyMcpServer {
    if (!detail.server.enabled) {
      throw new RemoteError('company-mcp/disabled', 'MCP is disabled for this account', { id: detail.server.id })
    }
    if (detail.server.status !== 'available') {
      throw new RemoteError('company-mcp/unavailable', 'MCP is unavailable', { id: detail.server.id, status: detail.server.status })
    }
    return detail.server
  }
  private async load(subject: WecomMarketSubject, caller?: AbortSignal): Promise<CompanyMcpServer[]> {
    this.checkSubject(subject)
    const signal = this.catalogSignal(caller)
    const budget = { remaining: this.config.maxCatalogBytes }
    const servers: CompanyMcpServer[] = []
    const ids = new Set<string>()
    let total: number | undefined
    for (let pageNum = 1; ; pageNum++) {
      const parsed = pageSchema.safeParse(await this.post('page', subject, { pageNum, pageSize: this.config.pageSize }, signal, budget))
      if (!parsed.success) throw invalid()
      const page = parsed.data
      if (page.pageNum !== pageNum || page.pageSize !== this.config.pageSize || page.total > this.config.maxServers
        || page.records.length > this.config.pageSize || (total !== undefined && page.total !== total)) throw invalid()
      total = page.total
      for (const item of page.records) {
        if (ids.has(item.id) || ids.size >= total) throw invalid()
        ids.add(item.id)
        const detail = await this.detail(subject, brandString<CompanyMcpId>(item.id), signal, budget)
        if (detail.path !== item.path) throw invalid()
        servers.push(detail.server)
      }
      if (ids.size === total) return servers
      if (page.records.length !== this.config.pageSize) throw invalid()
    }
  }
  private async detail(subject: WecomMarketSubject, id: CompanyMcpId, signal: AbortSignal, budget: Budget): Promise<ServerDetail> {
    const parsed = detailSchema.safeParse(await this.post('detail', subject, { id }, signal, budget))
    if (!parsed.success || parsed.data.id !== id || parsed.data.tools.length > this.config.maxTools) throw invalid()
    const names = new Set<string>()
    const tools = parsed.data.tools.map((tool): CompanyMcpTool => {
      try {
        if (tool.inputSchema.type !== 'object') throw invalid()
        assertSupportedJsonSchema(tool.inputSchema)
      } catch (_unsupportedSchema) { throw invalid() }
      const name = companyMcpToolName(id, tool.name)
      if (names.has(name)) throw invalid()
      names.add(name)
      const toolSchema: ToolSchema = { name, description: tool.description, parameters: tool.inputSchema }
      return { name, rawName: tool.name, description: tool.description,
        parametersJson: JSON.stringify(tool.inputSchema), fingerprint: companyMcpFingerprint(toolSchema) }
    })
    return { path: parsed.data.path, server: { id, name: parsed.data.name, description: parsed.data.description,
      enabled: this.requireDomain().table('servers').get(this.key(subject, id))?.enabled ?? true,
      status: parsed.data.status, tools } }
  }
  private definition(subject: WecomMarketSubject, id: CompanyMcpId, tool: CompanyMcpTool, toolSchema: ToolSchema): ToolDefinition {
    return { ...toolSchema, timeoutMs: this.config.callTimeoutMs,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: (args, execution) => this.track(async () => {
        if (execution.agent === undefined) throw forbidden()
        const actor = this.ctx.companyWecomAuth.marketSubject(execution.agent.id)
        if (actor.scope !== subject.scope) throw forbidden()
        const signal = AbortSignal.any([execution.signal, this.lifetime.signal, AbortSignal.timeout(this.config.callTimeoutMs)])
        const detail = await this.detail(actor, id, signal, { remaining: this.config.maxCatalogBytes })
        const current = this.usable(detail).tools.find(item => item.name === tool.name)
        if (current?.fingerprint !== tool.fingerprint) throw new RemoteError('company-mcp/tool-changed', 'MCP tool changed; save and publish the Agent again', { name: tool.name })
        const input = await this.post('invoke', actor, { id, path: detail.path, tool: tool.rawName, arguments: args ?? {},
          schemaFingerprint: tool.fingerprint }, signal, { remaining: this.config.maxResultBytes })
        const parsed = resultSchema.safeParse(input)
        if (!parsed.success) throw new RemoteError('company-mcp/call-outcome-unknown', 'MCP returned an invalid result; check the operation before retrying', { name: tool.name, reason: 'invalid-response' })
        if (parsed.data.isError) throw new RemoteError('company-mcp/call-failed', 'MCP reported a tool failure; check the operation before retrying', { name: tool.name, reason: 'tool-error' })
        return parsed.data.content.map(block => block.text).join('\n')
      }) }
  }
  private async post(route: 'page' | 'detail' | 'invoke', subject: WecomMarketSubject, fields: object,
    signal: AbortSignal, budget: Budget): Promise<unknown> {
    this.checkSubject(subject)
    signal.throwIfAborted()
    let credential: Awaited<ReturnType<Context['credentials']['resolve']>>
    try { credential = await this.ctx.credentials.resolve(this.tokenRef) }
    catch (_credentialFailure) { throw new RemoteError('company-mcp/catalog-unavailable', 'MCP service credential is unavailable; contact the administrator', {}) }
    if (credential === undefined || !/^[\x21-\x7e]+$/.test(credential.value)) {
      throw new RemoteError('company-mcp/catalog-unavailable', 'MCP service credential is missing or invalid; contact the administrator', {})
    }
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetch(new URL(`api/internal/mcp/authorized/${route}`, this.baseUrl), { method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...fields, corpId: subject.corpId, sub: subject.sub }) })
    } catch (_networkFailure) { throw this.requestFailure(route) }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      if (response.status === 403) throw forbidden()
      throw this.requestFailure(route)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        budget.remaining -= chunk.value.length
        if (budget.remaining < 0) throw this.requestFailure(route)
        chunks.push(chunk.value)
      }
    } catch (_readFailure) { throw this.requestFailure(route) }
    finally {
      try { await reader.cancel() } catch (_cancelFailure) { /* The request failure remains authoritative. */ }
      reader.releaseLock()
    }
    let input: unknown
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch (_invalidJson) { throw this.requestFailure(route) }
    const parsed = envelope.safeParse(input)
    if (!parsed.success) throw this.requestFailure(route)
    if (!parsed.data.success || parsed.data.code !== '200') {
      if (parsed.data.code === 'FORBIDDEN' || parsed.data.code === 'NOT_FOUND') throw forbidden()
      if (parsed.data.code === 'TOOL_CHANGED') throw new RemoteError('company-mcp/tool-changed', 'MCP tool changed; save and publish the Agent again', { name: 'selected-tool' })
      throw this.requestFailure(route)
    }
    return parsed.data.data
  }
  private requestFailure(route: string): RemoteError {
    return route === 'invoke'
      ? new RemoteError('company-mcp/call-outcome-unknown', 'MCP call outcome is unknown; check the operation before retrying', { name: 'selected-tool', reason: 'request-failed' })
      : new RemoteError('company-mcp/catalog-unavailable', 'MCP catalog is unavailable; refresh to try again', {})
  }
}

export default HttpCompanyMcpProvider
