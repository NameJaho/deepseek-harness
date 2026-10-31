/** Read-only adapter for the existing Market APIs; directory reads never invoke MCP tools. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-company-wecom-auth'
import type { CompanyMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'
import { CompanyMcpProvider, companyMcpFingerprint, companyMcpNamespace, companyMcpToolName, type CompanyMcpResolvedTool } from './provider.ts'
import type { CompanyMcpCatalog, CompanyMcpId, CompanyMcpServer, CompanyMcpTool, CompanyMcpToolRoute } from './types.ts'

/** Existing Market backend address and bounded directory reads. */
export interface Config {
  /** Market backend root including its context path, such as /mcp-market. */
  baseUrl: string
  /** Enterprise whose official WeCom users the deployment accepts. */
  corpId: string
  /** Whole directory or discovery deadline in milliseconds. */
  catalogTimeoutMs: number
  /** Total response bytes across identity resolution, pagination and permission checks. */
  maxCatalogBytes: number
  /** Maximum visible candidate servers before member permission filtering. */
  maxServers: number
  /** Maximum HR records examined to resolve a verified login identity. */
  maxIdentityRecords: number
  /** Maximum tools returned by one server. */
  maxTools: number
  /** Market page size, bounded by the existing APIs' limit of 100. */
  pageSize: number
}

/** Loader validation for the optional existing-API adapter. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().required(), corpId: z.string().min(1).required(),
  catalogTimeoutMs: z.natural().min(1).default(10_000),
  maxCatalogBytes: z.natural().min(1).default(2 * 1024 * 1024),
  maxServers: z.natural().min(1).default(500), maxIdentityRecords: z.natural().min(1).default(5000),
  maxTools: z.natural().min(1).default(500), pageSize: z.natural().min(1).max(100).default(100),
})

const text = (max: number) => schema.string().min(1).max(max)
const idSchema = schema.number().int().positive()
const memberSchema = schema.object({ userId: schema.number().int().nonnegative(), thirdUid: schema.string(),
  name: schema.string().nullable(), userStatus: schema.string() })
const summarySchema = schema.object({ id: idSchema, name: text(200), displayName: schema.string().nullable(),
  description: schema.string().nullable(), authorized: schema.boolean(), accessStatus: schema.string().nullable(),
  toolCount: schema.number().int().nonnegative() })
const pagination = { total: schema.number().int().nonnegative(), pageNum: schema.number().int().positive(),
  pageSize: schema.number().int().min(1).max(100) }
const membersPage = schema.object({ ...pagination, records: schema.array(memberSchema) })
const catalogPage = schema.object({ ...pagination, records: schema.array(summarySchema) })
const permissionSchema = schema.object({ allowed: schema.boolean(), reason: schema.string(), sub: schema.string(),
  path: schema.string(), userId: idSchema.nullable(), mcpServiceId: idSchema.nullable() })
const detailSchema = schema.object({ id: idSchema, name: text(200) })
const toolsSchema = schema.array(schema.object({ toolName: text(200), description: schema.string().nullable(),
  inputSchema: schema.string().nullable() }))
const envelope = schema.object({ success: schema.boolean(), code: schema.string(), data: schema.unknown().optional() })
type MarketSummary = schema.infer<typeof summarySchema>
interface Budget { remaining: number }
interface Viewer { sub: string; userId: number; name: string }
interface Directory { servers: CompanyMcpServer[]; summaries: MarketSummary[]; viewer: Viewer }
type Route = 'api/mcp/admin/user/list' | 'api/mcp/list' | 'api/mcp/query/by/id'
  | 'api/mcp/tool/list' | 'api/internal/mcp/permission/check'

function invalid(): RemoteError<'company-mcp/invalid-response'> {
  return new RemoteError('company-mcp/invalid-response', 'MCP Market returned invalid data; refresh or contact the administrator', { reason: 'invalid-response' })
}
function forbidden(): RemoteError<'company-mcp/forbidden'> {
  return new RemoteError('company-mcp/forbidden', 'MCP access is unavailable for this account; check your Market permissions', {})
}
function unresolved(): RemoteError<'company-mcp/member-unresolved'> {
  return new RemoteError('company-mcp/member-unresolved', 'This login has no unique active Market account with a WeCom identity; contact the administrator', {})
}

/** Host-owned member directory with no shared user cache, invented routes or service token. */
export class HttpCompanyMcpProvider extends CompanyMcpProvider {
  static inject = ['companyWecomAuth']
  static Config = Config
  private readonly config: Config
  private readonly baseUrl: URL
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /** @param ctx - Host identity service and plugin lifetime.
   * @param config - existing Market backend, enterprise and request limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = Config(config)
    this.baseUrl = new URL(this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`)
    if (!['https:', 'http:'].includes(this.baseUrl.protocol) || this.baseUrl.username !== '' || this.baseUrl.password !== ''
      || this.baseUrl.search !== '' || this.baseUrl.hash !== '') throw new Error('company-mcp: baseUrl must be an HTTP(S) URL without credentials, query or fragment')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.operations])
    }, 'company-mcp: directory requests')
    ctx.companyWecomAuth.registerResourceProvider({ sessionOwner: () => undefined,
      bindings: () => [{ resource: { kind: 'global' }, role: { name: 'company:mcp', resource: 'global', actions: [
        'companyMcp/catalog', 'companyMcp/follow', 'companyMcp/refresh', 'companyMcp/discover',
      ] } }],
    })
  }

  /** Read published, visible MCPs allowed by the member's current permission checks.
   * @param subject - verified login or Session owner, never browser input.
   * @param caller - optional caller cancellation.
   * @returns a complete authorized directory, or an empty directory with a structured failure.
   */
  catalog(subject: CompanyMarketSubject, caller?: AbortSignal): Promise<CompanyMcpCatalog> {
    return this.track(async () => {
      try {
        const directory = await this.load(subject, this.signal(caller), { remaining: this.config.maxCatalogBytes })
        return { loaded: true, servers: directory.servers, refreshedAt: Date.now() }
      } catch (error) {
        if (this.lifetime.signal.aborted || caller?.aborted === true) throw error
        return { loaded: false, servers: [], failure: error instanceof RemoteError ? {
          code: error.code as import('./types.ts').CompanyMcpErrorCode, message: error.message,
        } : { code: 'company-mcp/catalog-unavailable', message: 'MCP catalog is unavailable; refresh to try again' } }
      }
    })
  }

  async refresh(subject: CompanyMarketSubject, signal?: AbortSignal): Promise<CompanyMcpCatalog> {
    return this.track(async () => {
      const catalog = await this.catalog(subject, signal)
      this.ctx.emit('company-mcp/changed')
      return catalog
    })
  }

  discover(subject: CompanyMarketSubject, id: CompanyMcpId, signal: AbortSignal): Promise<readonly CompanyMcpTool[]> {
    return this.track(async () => {
      const deadline = this.signal(signal)
      const budget = { remaining: this.config.maxCatalogBytes }
      const directory = await this.load(subject, deadline, budget)
      const item = directory.summaries.find(item => String(item.id) === id)
      if (item === undefined) throw forbidden()
      return this.tools(item, directory.viewer, deadline, budget)
    })
  }

  discoverTools(subject: CompanyMarketSubject, id: CompanyMcpId): Promise<readonly CompanyMcpTool[]> {
    return this.discover(subject, id, this.lifetime.signal)
  }

  resolveTool(subject: CompanyMarketSubject, name: string): Promise<CompanyMcpResolvedTool | undefined> {
    return this.track(async () => {
      const signal = this.signal()
      const budget = { remaining: this.config.maxCatalogBytes }
      const directory = await this.load(subject, signal, budget)
      const item = directory.summaries.find(item => name.startsWith(`mcp__${companyMcpNamespace(brandString<CompanyMcpId>(String(item.id)))}__`))
      if (item === undefined) return undefined
      const tool = (await this.tools(item, directory.viewer, signal, budget)).find(tool => tool.name === name)
      if (tool === undefined) return undefined
      const toolSchema: ToolSchema = { name, description: tool.description,
        parameters: JSON.parse(tool.parametersJson) as Record<string, unknown> }
      const definition: ToolDefinition = { ...toolSchema,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value) }] },
        execute: () => Promise.reject(new RemoteError('company-mcp/call-unavailable',
          'MCP invocation is not connected; this integration currently provides the member directory and tool discovery', {})),
      }
      return { schema: toolSchema, fingerprint: tool.fingerprint, tool: definition }
    })
  }

  async describeTool(subject: CompanyMarketSubject, name: string): Promise<CompanyMcpToolRoute | undefined> {
    const catalog = await this.catalog(subject)
    const server = catalog.servers.find(server => name.startsWith(`mcp__${companyMcpNamespace(server.id)}__`))
    if (server === undefined) return undefined
    const tool = (await this.discoverTools(subject, server.id)).find(tool => tool.name === name)
    return tool === undefined ? undefined : { serverId: server.id, rawName: tool.rawName,
      description: tool.description, fingerprint: tool.fingerprint }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new RemoteError('company-mcp/stopping', 'MCP provider is stopping', {}))
    const pending = operation()
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }
  private signal(caller?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.catalogTimeoutMs),
      ...caller === undefined ? [] : [caller]])
  }
  private async viewer(subject: CompanyMarketSubject, signal: AbortSignal, budget: Budget): Promise<Viewer> {
    if ('sub' in subject) {
      if (subject.corpId !== this.config.corpId || subject.sub.trim() === '' || subject.sub.length > 64
        || subject.scope !== `wecom:${subject.corpId}:${subject.sub}`) throw forbidden()
    } else if (subject.scope !== `gateway:${subject.portalUserId}` || !/^[1-9][0-9]*$/.test(subject.portalUserId)
      || !Number.isSafeInteger(Number(subject.portalUserId))) throw forbidden()
    const matches: Viewer[] = []
    let total: number | undefined
    let count = 0
    for (let pageNum = 1; ; pageNum++) {
      const input = await this.post('api/mcp/admin/user/list', {
        ...'sub' in subject ? { keyword: subject.sub } : {}, activeOnly: true, pageNum, pageSize: this.config.pageSize,
      }, undefined, signal, budget)
      const parsed = membersPage.safeParse(input)
      if (!parsed.success) throw invalid()
      const page = parsed.data
      this.page(page, pageNum, total, count, this.config.maxIdentityRecords)
      total = page.total
      count += page.records.length
      for (const member of page.records) {
        if ('sub' in subject ? member.thirdUid !== subject.sub : String(member.userId) !== subject.portalUserId) continue
        if (member.userId <= 0 || member.thirdUid.trim() === '' || member.userStatus !== '3') throw unresolved()
        matches.push({ sub: member.thirdUid, userId: member.userId, name: member.name || member.thirdUid })
      }
      if (count === total) break
    }
    const [member] = matches
    if (matches.length !== 1 || member === undefined) throw unresolved()
    return member
  }
  private page(page: { pageNum: number; pageSize: number; total: number; records: readonly unknown[] },
    pageNum: number, total: number | undefined, count: number, limit: number): void {
    if (page.pageNum !== pageNum || page.pageSize !== this.config.pageSize || page.total > limit
      || total !== undefined && total !== page.total || page.records.length > this.config.pageSize
      || count + page.records.length > page.total
      || count + page.records.length < page.total && page.records.length !== this.config.pageSize) throw invalid()
  }
  private async load(subject: CompanyMarketSubject, signal: AbortSignal, budget: Budget): Promise<Directory> {
    const viewer = await this.viewer(subject, signal, budget)
    const servers: CompanyMcpServer[] = []
    const summaries: MarketSummary[] = []
    const ids = new Set<number>()
    let total: number | undefined
    for (let pageNum = 1; ; pageNum++) {
      const parsed = catalogPage.safeParse(await this.post('api/mcp/list', {
        pageNum, pageSize: this.config.pageSize, accessFilter: 'all',
      }, viewer, signal, budget))
      if (!parsed.success) throw invalid()
      const page = parsed.data
      this.page(page, pageNum, total, ids.size, this.config.maxServers)
      total = page.total
      for (const item of page.records) {
        if (ids.has(item.id)) throw invalid()
        ids.add(item.id)
        const permission = permissionSchema.safeParse(await this.post('api/internal/mcp/permission/check',
          { sub: viewer.sub, path: item.name }, undefined, signal, budget))
        if (!permission.success || permission.data.sub !== viewer.sub || permission.data.path !== item.name
          || permission.data.mcpServiceId !== item.id
          || permission.data.userId !== null && permission.data.userId !== viewer.userId) throw invalid()
        if (!permission.data.allowed || item.accessStatus?.trim().toLowerCase() === 'refactoring') continue
        summaries.push(item)
        servers.push({ id: brandString<CompanyMcpId>(String(item.id)), name: item.displayName || item.name,
          description: item.description ?? '', enabled: true, status: 'available', toolCount: item.toolCount, tools: [] })
      }
      if (ids.size === total) return { viewer, servers, summaries }
    }
  }
  private async tools(item: MarketSummary, viewer: Viewer, signal: AbortSignal, budget: Budget): Promise<CompanyMcpTool[]> {
    const detail = detailSchema.safeParse(await this.post('api/mcp/query/by/id', { id: item.id }, viewer, signal, budget))
    if (!detail.success || detail.data.id !== item.id || detail.data.name !== item.name) throw invalid()
    const parsed = toolsSchema.safeParse(await this.post('api/mcp/tool/list', { mcpServiceId: item.id }, viewer, signal, budget))
    if (!parsed.success || parsed.data.length > this.config.maxTools) throw invalid()
    const names = new Set<string>()
    return parsed.data.map((tool) => {
      let parameters: unknown
      try { parameters = JSON.parse(tool.inputSchema ?? '') } catch (_invalidSchema) { throw invalid() }
      const checked = schema.record(schema.string(), schema.unknown()).safeParse(parameters)
      if (!checked.success || checked.data.type !== 'object') throw invalid()
      try { assertSupportedJsonSchema(checked.data) } catch (_unsupportedSchema) { throw invalid() }
      const name = companyMcpToolName(brandString<CompanyMcpId>(String(item.id)), tool.toolName)
      if (names.has(name)) throw invalid()
      names.add(name)
      const definition: ToolSchema = { name, description: tool.description ?? '', parameters: checked.data }
      return { name, rawName: tool.toolName, description: definition.description,
        parametersJson: JSON.stringify(checked.data), fingerprint: companyMcpFingerprint(definition) }
    })
  }
  private async post(route: Route, fields: object, viewer: Viewer | undefined, signal: AbortSignal, budget: Budget): Promise<unknown> {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetch(new URL(route, this.baseUrl), { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...viewer === undefined ? {}
          : { 'x-user-info': encodeURIComponent(JSON.stringify({ userId: viewer.userId, userName: viewer.name })) } },
        body: JSON.stringify(fields) })
    } catch (_networkFailure) { throw new RemoteError('company-mcp/catalog-unavailable', 'MCP Market is unavailable; refresh to try again', {}) }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) throw forbidden()
      throw invalid()
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        budget.remaining -= chunk.value.length
        if (budget.remaining < 0) throw invalid()
        chunks.push(chunk.value)
      }
    } finally {
      try { await reader.cancel() } catch (_cancelFailure) { /* The original read failure remains authoritative. */ }
      reader.releaseLock()
    }
    let input: unknown
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch (_invalidJson) { throw invalid() }
    const parsed = envelope.safeParse(input)
    if (!parsed.success) throw invalid()
    if (!parsed.data.success || parsed.data.code !== '200') {
      if (['10001', '10027', '10068', '10069'].includes(parsed.data.code)) throw forbidden()
      throw invalid()
    }
    return parsed.data.data
  }
}

export default HttpCompanyMcpProvider
