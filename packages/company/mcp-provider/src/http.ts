/** HTTP gateway adapter for `ctx.companyMcpProvider`; the gateway URLs and bearer token stay inside this Host plugin. */
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { CompanyMcpProvider, companyMcpFingerprint, companyMcpToolName } from './provider.ts'
import type { CompanyMcpResolvedTool } from './provider.ts'
import type { CompanyMcpCatalog, CompanyMcpErrorCode, CompanyMcpFailure, CompanyMcpId, CompanyMcpServer, CompanyMcpStatus,
  CompanyMcpTool, CompanyMcpToolRoute } from './types.ts'

/** Gateway locations, the bearer-token reference and limits. */
export interface Config {
  /** HTTP(S) URL answering `GET` with the server and tool catalog. */
  catalogUrl: string
  /** HTTP(S) URL answering `POST` tool calls. */
  invokeUrl: string
  /** Credential reference for the gateway bearer token; an unset credential sends no `Authorization` header. */
  tokenRef?: string
  /** Timeout for one catalog request in milliseconds. */
  catalogTimeoutMs: number
  /** Timeout for one tool call in milliseconds. */
  callTimeoutMs: number
  /** Maximum catalog response size in bytes. */
  maxCatalogBytes: number
  /** Maximum tool-call response size in bytes. */
  maxResultBytes: number
}

/** Loader validation; both URLs are required. */
export const Config: z<Config> = z.object({
  catalogUrl: z.string().required(),
  invokeUrl: z.string().required(),
  tokenRef: z.string(),
  catalogTimeoutMs: z.natural().min(1).default(10_000),
  callTimeoutMs: z.natural().min(1).default(60_000),
  maxCatalogBytes: z.natural().min(1).default(2 * 1024 * 1024),
  maxResultBytes: z.natural().min(1).default(1024 * 1024),
})

const preferenceSchema = schema.object({ enabled: schema.boolean() }).strict()
const preferences = defineDomain({ name: 'company_mcp_provider', version: 1,
  tables: { servers: domainTable<CompanyMcpId, schema.infer<typeof preferenceSchema>>(preferenceSchema) } })

const text = (max: number) => schema.string().max(max)
const catalogSchema = schema.object({
  servers: schema.array(schema.object({
    id: schema.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    name: text(200).min(1),
    description: text(4000).default(''),
    status: schema.enum(['available', 'connecting', 'failed', 'maintenance']),
    updated_at: schema.iso.datetime({ offset: true }).optional(),
    tools: schema.array(schema.object({
      name: text(200).min(1),
      description: text(8000).default(''),
      input_schema: schema.record(schema.string(), schema.unknown()),
    })).max(500),
  })).max(500),
})
const resultSchema = schema.discriminatedUnion('status', [
  schema.object({ status: schema.literal('ok'), is_error: schema.boolean().optional(),
    content: schema.array(schema.object({ type: schema.literal('text'), text: schema.string() })) }),
  schema.object({ status: schema.literal('error'), error: schema.object({ code: text(200), message: text(2000) }) }),
])

interface Snapshot {
  readonly servers: readonly (Omit<CompanyMcpServer, 'enabled'>)[]
  readonly refreshedAt: number
}

class GatewayFailure extends Error {
  constructor(readonly code: CompanyMcpErrorCode, readonly reason: string) { super(reason) }
}

function failureOf(error: unknown): CompanyMcpFailure {
  if (error instanceof GatewayFailure) return { code: error.code, message: error.reason }
  const remote = remoteErrorOf(error)
  if (remote !== undefined && remote.code.startsWith('company-mcp/')) {
    return { code: remote.code as CompanyMcpErrorCode, message: remote.message }
  }
  return { code: 'company-mcp/catalog-unavailable', message: 'MCP catalog request failed' }
}

/** The configured company MCP gateway; one instance owns all upstream requests. */
export class HttpCompanyMcpProvider extends CompanyMcpProvider {
  static inject = ['storageDomain', 'credentials']
  static Config = Config
  private readonly config: Config
  private readonly catalogUrl: URL
  private readonly invokeUrl: URL
  private readonly tokenRef: CredentialRef | undefined
  private readonly lifetime = new AbortController()
  private readonly calls = new Set<Promise<unknown>>()
  private domain: Domain<typeof preferences> | undefined
  private snapshot: Snapshot | undefined
  private failure: CompanyMcpFailure | undefined
  private refreshing: Promise<CompanyMcpCatalog> | undefined

  /**
   * @param ctx - Host with storage domains and credentials.
   * @param config - gateway URLs, the bearer-token reference and limits.
   * @throws Error when a URL is not HTTP(S) or the token reference is not a credential name.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = Config(config)
    this.catalogUrl = httpUrl(this.config.catalogUrl, 'catalogUrl')
    this.invokeUrl = httpUrl(this.config.invokeUrl, 'invokeUrl')
    this.tokenRef = this.config.tokenRef === undefined ? undefined : credentialRef(this.config.tokenRef)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.refreshing?.catch((_refreshError: unknown) => { /* Refresh failures are recorded in `failure`. */ })
      await Promise.allSettled(this.calls)
      await this.domain?.close()
    }, 'company-mcp-http: requests and preferences')
  }

  /** Open preferences and attempt the first refresh; an unreachable gateway leaves `loaded` false. */
  async [CompanyMcpProvider.init](): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(preferences)
    await this.refresh()
  }

  /** @returns current catalog with saved enablement. */
  catalog(): Promise<CompanyMcpCatalog> {
    const table = this.domain?.table('servers')
    return Promise.resolve({ loaded: this.snapshot !== undefined,
      servers: (this.snapshot?.servers ?? []).map(server => ({ ...server, enabled: table?.get(server.id)?.enabled ?? true })),
      ...this.snapshot === undefined ? {} : { refreshedAt: this.snapshot.refreshedAt },
      ...this.failure === undefined ? {} : { failure: this.failure } })
  }

  /** @param signal - caller cancellation; concurrent callers share one request.
   * @returns refreshed catalog, or the retained catalog with `failure`.
   */
  refresh(signal?: AbortSignal): Promise<CompanyMcpCatalog> {
    signal?.throwIfAborted()
    if (this.refreshing !== undefined) return this.refreshing
    const task = this.load().then((snapshot) => {
      this.snapshot = snapshot
      this.failure = undefined
    }, (error: unknown) => {
      if (this.lifetime.signal.aborted) throw new RemoteError('company-mcp/stopping', 'MCP provider is stopping', {})
      this.failure = failureOf(error)
    }).then(() => {
      this.ctx.emit('company-mcp/changed')
      return this.catalog()
    }).finally(() => { this.refreshing = undefined })
    this.refreshing = task
    return task
  }

  /** @param request - server identity and enablement.
   * @returns updated catalog.
   */
  async configure(request: { readonly id: CompanyMcpId; readonly enabled: boolean }): Promise<CompanyMcpCatalog> {
    this.server(request.id)
    await this.requireDomain().table('servers').put(request.id, { enabled: request.enabled })
    this.ctx.emit('company-mcp/changed')
    return this.catalog()
  }

  /** @param id - server identity.
   * @param signal - caller cancellation.
   * @returns tools after a successful refresh.
   */
  async discover(id: CompanyMcpId, signal: AbortSignal): Promise<readonly CompanyMcpTool[]> {
    const catalog = await this.refresh(signal)
    signal.throwIfAborted()
    if (catalog.failure !== undefined) {
      throw new RemoteError(catalog.failure.code === 'company-mcp/invalid-response' ? 'company-mcp/invalid-response'
        : 'company-mcp/catalog-unavailable', catalog.failure.message,
      catalog.failure.code === 'company-mcp/invalid-response' ? { reason: catalog.failure.message } : {})
    }
    return this.discoverTools(id)
  }

  /** @param id - server identity.
   * @returns tools of an enabled, available server.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- converts synchronous availability failures into rejections.
  async discoverTools(id: CompanyMcpId): Promise<readonly CompanyMcpTool[]> {
    return this.usable(id).tools
  }

  /** @param name - model-facing tool name.
   * @returns current tool, or undefined when no server owns the name.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- converts synchronous availability failures into rejections.
  async resolveTool(name: string): Promise<CompanyMcpResolvedTool | undefined> {
    const owner = this.owner(name)
    if (owner === undefined) return undefined
    const server = this.usable(owner.server.id)
    const tool = server.tools.find(item => item.name === name)
    if (tool === undefined) throw new RemoteError('company-mcp/tool-changed', 'MCP tool is no longer available', { name })
    const toolSchema: ToolSchema = { name: tool.name, description: tool.description,
      parameters: JSON.parse(tool.parametersJson) as Record<string, unknown> }
    return { schema: toolSchema, fingerprint: tool.fingerprint, tool: this.definition(server.id, tool, toolSchema) }
  }

  /** @param name - model-facing tool name.
   * @returns non-secret route, or undefined when unknown.
   */
  describeTool(name: string): Promise<CompanyMcpToolRoute | undefined> {
    const owner = this.owner(name)
    return Promise.resolve(owner === undefined ? undefined : { serverId: owner.server.id, rawName: owner.tool.rawName,
      description: owner.tool.description, fingerprint: owner.tool.fingerprint })
  }

  private owner(name: string): { server: Omit<CompanyMcpServer, 'enabled'>; tool: CompanyMcpTool } | undefined {
    for (const server of this.snapshot?.servers ?? []) {
      const tool = server.tools.find(item => item.name === name)
      if (tool !== undefined) return { server, tool }
    }
    return undefined
  }

  private server(id: CompanyMcpId): Omit<CompanyMcpServer, 'enabled'> {
    if (this.snapshot === undefined) throw new RemoteError('company-mcp/catalog-unavailable', 'MCP catalog is unavailable', {})
    const server = this.snapshot.servers.find(item => item.id === id)
    if (server === undefined) throw new RemoteError('company-mcp/not-found', 'MCP server not found', { id })
    return server
  }

  private usable(id: CompanyMcpId): Omit<CompanyMcpServer, 'enabled'> {
    const server = this.server(id)
    if (this.domain?.table('servers').get(id)?.enabled === false) {
      throw new RemoteError('company-mcp/disabled', 'MCP server is disabled', { id })
    }
    if (server.status !== 'available') {
      throw new RemoteError('company-mcp/unavailable', 'MCP server is unavailable', { id, status: server.status })
    }
    return server
  }

  private requireDomain(): Domain<typeof preferences> {
    if (this.domain === undefined) throw new RemoteError('company-mcp/catalog-unavailable', 'MCP provider is starting', {})
    return this.domain
  }

  private async load(): Promise<Snapshot> {
    const input = await this.request(this.catalogUrl, { method: 'GET' }, this.config.catalogTimeoutMs,
      this.config.maxCatalogBytes, 'company-mcp/catalog-unavailable')
    const parsed = catalogSchema.safeParse(input)
    if (!parsed.success) throw new GatewayFailure('company-mcp/invalid-response', 'MCP catalog fields are missing or invalid')
    const ids = new Set<string>()
    const servers = parsed.data.servers.map((server) => {
      if (ids.has(server.id)) throw new GatewayFailure('company-mcp/invalid-response', `Duplicate MCP server id ${server.id}`)
      ids.add(server.id)
      const id = brandString<CompanyMcpId>(server.id)
      const names = new Set<string>()
      const tools = server.tools.map((tool): CompanyMcpTool => {
        try {
          if (tool.input_schema.type !== 'object') throw new Error('parameters must be an object schema')
          assertSupportedJsonSchema(tool.input_schema)
        } catch (_unsupportedSchema) {
          // The upstream schema text is not echoed: it is not needed to act on the failure.
          throw new GatewayFailure('company-mcp/invalid-response', `Unsupported parameter schema for ${server.id}/${tool.name}`)
        }
        const name = companyMcpToolName(id, tool.name)
        if (names.has(name)) throw new GatewayFailure('company-mcp/invalid-response', `Duplicate MCP tool ${server.id}/${tool.name}`)
        names.add(name)
        const toolSchema: ToolSchema = { name, description: tool.description, parameters: tool.input_schema }
        return { name, rawName: tool.name, description: tool.description, parametersJson: JSON.stringify(tool.input_schema),
          fingerprint: companyMcpFingerprint(toolSchema) }
      })
      const status: CompanyMcpStatus = server.status
      return { id, name: server.name, description: server.description, status, tools,
        ...server.updated_at === undefined ? {} : { updatedAt: Date.parse(server.updated_at) } }
    })
    return { servers, refreshedAt: Date.now() }
  }

  private definition(serverId: CompanyMcpId, tool: CompanyMcpTool, toolSchema: ToolSchema): ToolDefinition {
    return { ...toolSchema, timeoutMs: this.config.callTimeoutMs,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: (args, execution) => {
        const call = this.call(serverId, tool, args, execution.signal)
        this.calls.add(call)
        return call.finally(() => this.calls.delete(call))
      } }
  }

  private async call(serverId: CompanyMcpId, tool: CompanyMcpTool, args: unknown, signal: AbortSignal): Promise<string> {
    const current = this.usable(serverId).tools.find(item => item.name === tool.name)
    if (current?.fingerprint !== tool.fingerprint) {
      throw new RemoteError('company-mcp/tool-changed', 'MCP tool changed; discover and publish it again', { name: tool.name })
    }
    let input: unknown
    try {
      input = await this.request(this.invokeUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server_id: serverId, tool: tool.rawName, arguments: args ?? {} }) },
      this.config.callTimeoutMs, this.config.maxResultBytes, 'company-mcp/call-failed', signal)
    } catch (error) {
      throw new RemoteError('company-mcp/call-failed', 'MCP tool call failed', { name: tool.name, reason: failureOf(error).message })
    }
    const parsed = resultSchema.safeParse(input)
    if (!parsed.success) {
      throw new RemoteError('company-mcp/call-failed', 'MCP tool returned an unrecognized result', { name: tool.name, reason: 'invalid-response' })
    }
    if (parsed.data.status === 'error') {
      throw new RemoteError('company-mcp/call-failed', parsed.data.error.message, { name: tool.name, reason: parsed.data.error.code })
    }
    const output = parsed.data.content.map(block => block.text).join('\n')
    if (parsed.data.is_error === true) throw new Error(output === '' ? `MCP tool ${tool.rawName} reported an error` : output)
    return output
  }

  private async authorization(code: CompanyMcpErrorCode): Promise<Record<string, string>> {
    if (this.tokenRef === undefined) return {}
    let credential: Awaited<ReturnType<Context['credentials']['resolve']>>
    try {
      credential = await this.ctx.credentials.resolve(this.tokenRef)
    } catch (_credentialFailure: unknown) {
      // Credential provider errors can name storage locations; only the classification is reported.
      throw new GatewayFailure(code, 'MCP gateway credential is unavailable')
    }
    if (credential === undefined) return {}
    if (!/^[\x21-\x7e]+$/.test(credential.value)) throw new GatewayFailure(code, 'MCP gateway credential is not a valid token')
    return { authorization: `Bearer ${credential.value}` }
  }

  private async request(url: URL, init: RequestInit, timeoutMs: number, maxBytes: number, code: CompanyMcpErrorCode,
    caller?: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeoutMs), ...caller === undefined ? [] : [caller]])
    const authorization = await this.authorization(code)
    if (signal.aborted) throw new GatewayFailure(code, 'MCP gateway request timed out or was cancelled')
    let response: Response
    try {
      response = await fetch(url, { ...init, redirect: 'error', signal,
        headers: { accept: 'application/json', ...init.headers as Record<string, string> | undefined, ...authorization } })
    } catch (_fetchFailure) {
      // Fetch errors can include the private URL; only the classification is reported.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while fetch is awaited.
      throw new GatewayFailure(code, signal.aborted ? 'MCP gateway request timed out or was cancelled' : 'MCP gateway is unreachable')
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new GatewayFailure(code, `MCP gateway returned HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > maxBytes) throw new GatewayFailure(code, `MCP gateway response exceeds ${maxBytes} bytes`)
        chunks.push(chunk.value)
      }
    } catch (error) {
      if (error instanceof GatewayFailure) throw error
      throw new GatewayFailure(code, 'MCP gateway response was interrupted')
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    try {
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      return body
    } catch (_invalidBody) {
      // The body may echo private request data, so it is not included in the failure.
      throw new GatewayFailure('company-mcp/invalid-response', 'MCP gateway response is not UTF-8 JSON')
    }
  }
}

function httpUrl(value: string, field: string): URL {
  let url: URL
  try { url = new URL(value) } catch (_invalidUrl) {
    // The configured value may embed credentials, so it is not echoed.
    throw new Error(`company-mcp-http: ${field} must be an HTTP(S) URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`company-mcp-http: ${field} must be an HTTP(S) URL`)
  return url
}

export default HttpCompanyMcpProvider
