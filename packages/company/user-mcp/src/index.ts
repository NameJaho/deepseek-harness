/** Authenticated user MCP catalog, token exchange and Agent-scoped tool bridge. */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { syncTools, type ToolBridgeOptions, type ToolDisposers } from '@deepseek-ai/dsh-mcp-client'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z as schema } from 'zod'
import { Config } from './config.ts'
import type { UserMcpCatalog, UserMcpId, UserMcpTarget } from '@deepseek-ai/dsh-company-user-mcp/types'

export { Config } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated user MCP catalog and Agent-scoped bridge. */
    companyUserMcp: CompanyUserMcpService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The caller has no authenticated member principal. */
    'company-user-mcp/unauthenticated': Record<string, never>
    /** A required server-side credential is missing. */
    'company-user-mcp/missing-credential': Record<string, never>
    /** The user MCP catalog could not be validated or reached. */
    'company-user-mcp/catalog-failed': Record<string, never>
    /** An authorized MCP endpoint could not be initialized. */
    'company-user-mcp/connect-failed': { readonly mcp: UserMcpId }
  }
}

const tokenResponse = schema.object({
  access_token: schema.string().min(1),
  token_type: schema.string().min(1),
  expires_in: schema.number().int().positive(),
  scope: schema.string().optional(),
  resource: schema.url(),
})

const catalogRecord = schema.object({
  mcpServiceId: schema.number().int().optional(),
  name: schema.string().trim().min(1),
  displayName: schema.string().optional(),
  description: schema.string().optional(),
  accessType: schema.string().optional(),
})

const listResponse = schema.object({
  success: schema.boolean(),
  code: schema.string().optional(),
  msg: schema.string().optional(),
  data: schema.object({ records: schema.array(catalogRecord) }).optional(),
})

interface TokenEntry {
  readonly token: string
  readonly resource: string
  readonly expiresAt: number
}

interface ConnectionState {
  readonly target: UserMcpTarget
  readonly client: Client
  readonly token: TokenEntry
  disposers: ToolDisposers
}

interface AgentState {
  userId: string
  /** Time of the last catalog reconciliation; 0 forces a reload. */
  listedAt: number
  readonly servers: Map<string, ConnectionState>
}

const listToolName = 'queryUserAvailableMcp'

interface PrincipalState {
  /** Latest authenticated member id recorded by a Session `user/message`, or null. */
  readonly userId: string | null
}

const principalState = schema.object({ userId: schema.string().nullable() })

/** Read the authenticated member id attached to one user message. */
function principalUserId(message: UserMessage): string | undefined {
  const principal: unknown = Reflect.get(message.source, 'principal')
  const userId: unknown = typeof principal === 'object' && principal !== null ? Reflect.get(principal, 'userId') : undefined
  return typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : undefined
}

/** Authenticate one platform-backed user MCP service. */
export default class CompanyUserMcpService extends TypertRemoteService {
  static inject = ['tools', 'agents', 'sessionProjections']
  static Config = Config

  private readonly config: Config
  private readonly lifetime = new AbortController()
  private readonly tokenCache = new Map<string, TokenEntry>()
  private readonly agentStates = new WeakMap<Agent, AgentState>()
  private readonly preparations = new WeakMap<Agent, Promise<void>>()
  private readonly disposed = new WeakSet<Agent>()
  private readonly states = new Set<AgentState>()
  private readonly active = new Set<Promise<unknown>>()
  private principals!: ProjectionHandle<PrincipalState>

  /** @param owner - Host context containing the tool registry and Remote gateway. @param config - validated bridge configuration. */
  constructor(private readonly owner: Context, config: Config) {
    super(owner, 'companyUserMcp', { namespace: 'companyUserMcp' })
    this.config = Config(config)
    this.requireHttpUrl(this.config.listUrl, 'listUrl')
    this.requireHttpUrl(this.config.exchangeUrl, 'exchangeUrl')
    owner.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.active)
      await Promise.all([...this.states].map(state => this.clearAgent(state)))
      this.states.clear()
    }, 'company-user-mcp: lifetime')
  }

  /** Register the member projection, then start Agent reconciliation when enabled. */
  protected async [Service.init](): Promise<void> {
    if (!this.config.enabled) return
    this.principals = await this.owner.sessionProjections.register({
      key: 'companyUserMcpPrincipal',
      stateVersion: 1,
      stateSchema: principalState,
      init: () => ({ userId: null }),
      apply: (state, event) => {
        if (event.type !== 'user/message') return state
        const userId = principalUserId(event.data)
        return userId === undefined || userId === state.userId ? state : { userId }
      },
    })
    // The step's tool set is resolved before `agent/pre-step`, so connections start as early as the user is known.
    this.owner.on('agent/created', ({ agent }) => { void this.schedule(agent, []) })
    this.owner.on('agent/inbox/inserted', ({ agent, message }) => {
      if (principalUserId(message) !== undefined) void this.schedule(agent, [message])
    })
    this.owner.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      await this.untilAborted(this.schedule(agent, messages), signal)
      signal.throwIfAborted()
      return next()
    })
    this.owner.on('agent/disposed', ({ agent }) => { void this.disposeAgent(agent) })
  }

  /** Fail load-time on malformed configured endpoint URLs. */
  private requireHttpUrl(value: string, key: string): void {
    let url: URL
    try { url = new URL(value) } catch (error) { throw new Error(`company-user-mcp: ${key} must be an HTTP(S) URL`, { cause: error }) }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`company-user-mcp: ${key} must be an HTTP(S) URL`)
  }

  /** Return the logged-in caller's authorized MCP catalog without credentials or endpoints.
   * @returns credential-free MCP summaries for the authenticated caller.
   */
  @Remote
  async catalog(): Promise<UserMcpCatalog> {
    const userId = this.remoteUserId()
    const targets = await this.listUserMcps(userId)
    return { userId, entries: targets.map(({ mcpName: _mcpName, ...entry }) => entry) }
  }

  /** Extract the authenticated principal from the current Remote invocation. */
  private remoteUserId(): string {
    const principal = principalOf(this.ctx.invocation)
    const value: unknown = principal === undefined ? undefined : Reflect.get(principal, 'userId')
    if (typeof value !== 'string' || value.trim() === '') throw new RemoteError('company-user-mcp/unauthenticated', 'An authenticated user is required', {})
    return value.trim()
  }

  /**
   * Queue one reconciliation after the Agent's previous one; never rejects.
   * @param agent - Agent whose scoped tools are reconciled.
   * @param messages - newest messages that may carry the caller principal.
   * @returns completion of this reconciliation.
   */
  private schedule(agent: Agent, messages: readonly UserMessage[]): Promise<void> {
    const run = (this.preparations.get(agent) ?? Promise.resolve())
      .then(() => this.prepareAgent(agent, messages))
      .catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) this.owner.logger.warn(`company-user-mcp: preparation failed: ${this.describe(error)}`)
      })
    this.preparations.set(agent, run)
    this.active.add(run)
    void run.finally(() => { this.active.delete(run) })
    return run
  }

  /** Wait for shared work, or only until one step is cancelled; the work itself continues. */
  private async untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const aborted = Promise.withResolvers<undefined>()
    const abort = (): void => { aborted.resolve(undefined) }
    signal.addEventListener('abort', abort, { once: true })
    try { await Promise.race([work, aborted.promise]) } finally { signal.removeEventListener('abort', abort) }
  }

  /** Load a catalog and reconcile its tools into the exact Agent scope. */
  private async prepareAgent(agent: Agent, messages: readonly UserMessage[]): Promise<void> {
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    if (this.disposed.has(agent)) return
    const userId = this.userIdForAgent(agent, messages)
    if (userId === undefined) return
    const previous = this.agentStates.get(agent)
    const state = previous ?? { userId, listedAt: 0, servers: new Map<string, ConnectionState>() }
    if (state.userId !== userId) {
      await this.clearAgent(state)
      state.userId = userId
      state.listedAt = 0
    }
    this.agentStates.set(agent, state)
    this.states.add(state)
    if (state.listedAt !== 0 && Date.now() - state.listedAt < this.config.catalogTtlMs) return
    let targets: UserMcpTarget[]
    try { targets = await this.listUserMcps(userId) }
    catch (error) {
      this.owner.logger.warn(`company-user-mcp: catalog unavailable, keeping current tools: ${this.describe(error)}`)
      return
    }
    signal.throwIfAborted()
    if (this.agentStates.get(agent) !== state) return
    const nextKeys = new Set(targets.map(target => this.targetKey(target)))
    for (const [key, connection] of state.servers) {
      if (!nextKeys.has(key)) {
        state.servers.delete(key)
        await this.closeConnection(connection)
      }
    }
    const missing = targets.filter(target => !state.servers.has(this.targetKey(target)))
    const results = await Promise.all(missing.map(async (target) => {
      try { return { target, connection: await this.connectTarget(target, userId, agent) } }
      catch (error) { return { target, error } }
    }))
    for (const result of results) {
      if (!('connection' in result)) {
        // One unreachable or misconfigured server must not fail the turn; the next catalog refresh retries it.
        this.owner.logger.warn(`company-user-mcp: skipped ${result.target.mcpName}: ${this.describe(result.error)}`)
        continue
      }
      if (this.agentStates.get(agent) === state && !signal.aborted) state.servers.set(this.targetKey(result.target), result.connection)
      else await this.closeConnection(result.connection)
    }
    state.listedAt = Date.now()
  }

  /** Render the most specific failure text without credentials. */
  private describe(error: unknown): string {
    return String(error instanceof Error && error.cause !== undefined ? error.cause : error)
  }

  /** Prefer a member named by pending messages, then the latest member recorded by the Session. */
  private userIdForAgent(agent: Agent, messages: readonly UserMessage[]): string | undefined {
    for (const message of [...messages].reverse()) {
      const userId = principalUserId(message)
      if (userId !== undefined) return userId
    }
    return this.principals.stateOf(agent.session).userId ?? undefined
  }

  /** Establish one token-authenticated MCP connection and publish its tools. */
  private async connectTarget(target: UserMcpTarget, userId: string, agent: Agent): Promise<ConnectionState> {
    const token = await this.exchangeToken(userId, target)
    const headers = { Authorization: `Bearer ${token.token}` }
    const client = new Client({ name: 'dsh-company-user-mcp', version: '0.1.0' }, { capabilities: {} })
    try {
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl(token.resource)), { requestInit: { headers } })
      const pending = client.connect(transport, { timeout: this.config.connectionTimeoutMs })
      this.active.add(pending)
      await pending.finally(() => { this.active.delete(pending) })
      const state: ConnectionState = { target, client, token, disposers: new Map() }
      state.disposers = await syncTools(client, agent.ctx, this.bridgeOptions(target), state.disposers)
      return state
    } catch (error) {
      await this.closeClient(client)
      throw new RemoteError('company-user-mcp/connect-failed', 'Could not connect to an authorized MCP server', { mcp: target.id }, { cause: error })
    }
  }

  /** Build the MCP endpoint from the token resource without exposing it to callers. */
  private mcpUrl(resource: string): string {
    const url = new URL(resource)
    if (!url.pathname.endsWith('/mcp')) url.pathname = `${url.pathname.replace(/\/$/, '')}/mcp`
    return url.toString()
  }

  /** Stable namespace used only for model-facing tool names. */
  private bridgeOptions(target: UserMcpTarget): ToolBridgeOptions {
    const normalized = target.mcpName.replace(/[^A-Za-z0-9_-]/g, '_')
    const digest = createHash('sha256').update(target.mcpName).digest('hex').slice(0, 8)
    return { registrationFailure: 'throw', serverName: `${normalized.slice(0, 23)}_${digest}`, toolCallTimeoutMs: this.config.toolCallTimeoutMs }
  }

  /** Query the list MCP server using its server-side API key. */
  private async listUserMcps(userId: string): Promise<UserMcpTarget[]> {
    const apiKey = process.env[this.config.listApiKeyEnv]
    if (apiKey === undefined || apiKey.trim() === '') throw new RemoteError('company-user-mcp/missing-credential', 'The user MCP list credential is not configured', {})
    const client = new Client({ name: 'dsh-company-user-mcp-catalog', version: '0.1.0' }, { capabilities: {} })
    const headers = { Authorization: `Bearer ${apiKey}` }
    try {
      const transport = new StreamableHTTPClientTransport(new URL(this.config.listUrl), { requestInit: { headers } })
      const pending = client.connect(transport, { timeout: this.config.connectionTimeoutMs })
      this.active.add(pending)
      await pending.finally(() => { this.active.delete(pending) })
      const tools = await client.listTools(undefined, { timeout: this.config.connectionTimeoutMs })
      if (!tools.tools.some(tool => tool.name === listToolName)) {
        throw new Error(`catalog MCP does not expose ${listToolName}`)
      }
      const result = await client.callTool({ name: listToolName, arguments: { thirdUid: userId, accessType: 'all', pageNo: 1, pageSize: this.config.maxServers } }, { timeout: this.config.requestTimeoutMs })
      return this.parseCatalogResult(result)
    } catch (error) {
      throw new RemoteError('company-user-mcp/catalog-failed', 'Could not load the authenticated MCP catalog', {}, { cause: error })
    } finally { await this.closeClient(client) }
  }

  /** Validate the catalog's structured result and keep only fields DSH uses. */
  private parseCatalogResult(result: object): UserMcpTarget[] {
    const parsed = listResponse.safeParse(Reflect.get(result, 'structuredContent'))
    if (!parsed.success) throw new Error('catalog MCP returned an invalid response')
    const { success, code, msg, data } = parsed.data
    if (!success || data === undefined) throw new Error(`catalog request failed (${code ?? 'unknown'}): ${msg ?? ''}`)
    return data.records.slice(0, this.config.maxServers).map(({ mcpServiceId, name, displayName, description, accessType }) => ({
      id: brandString<UserMcpId>(String(mcpServiceId ?? name)),
      mcpName: name,
      displayName: displayName === undefined || displayName === '' ? name : displayName,
      description: description ?? '',
      environment: this.config.environment,
      accessType: accessType === 'open' || accessType === 'authorized' ? accessType : 'unknown',
    }))
  }

  /** Exchange a short-lived token with an exact raw request body and HMAC signature. */
  private async exchangeToken(userId: string, target: UserMcpTarget): Promise<TokenEntry> {
    const key = `${userId}\0${target.mcpName}\0${target.environment}`
    const cached = this.tokenCache.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached
    const secret = process.env[this.config.platformSecretEnv]
    if (secret === undefined || secret.trim() === '') throw new RemoteError('company-user-mcp/missing-credential', 'The platform exchange secret is not configured', {})
    const body = Buffer.from(JSON.stringify({ user_id: userId, mcp_name: target.mcpName, environment: target.environment }), 'utf8')
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(24).toString('base64url')
    const digest = createHash('sha256').update(body).digest('hex')
    const message = `${this.config.platformId}\n${timestamp}\n${nonce}\n${digest}`
    const signature = createHmac('sha256', secret).update(message, 'utf8').digest('hex')
    const response = await fetch(this.config.exchangeUrl, {
      method: 'POST', redirect: 'error', body,
      headers: { 'content-type': 'application/json', 'X-Platform-Id': this.config.platformId, 'X-Platform-Timestamp': timestamp, 'X-Platform-Nonce': nonce, 'X-Platform-Signature': `v1=${signature}` },
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
    })
    if (!response.ok) { await response.text(); throw new Error(`token exchange failed (${response.status})`) }
    const parsed = tokenResponse.safeParse(await response.json())
    if (!parsed.success) throw new Error('token exchange returned an invalid response')
    const { access_token: token, resource, expires_in: expiresIn } = parsed.data
    const entry: TokenEntry = { token, resource, expiresAt: Date.now() + expiresIn * 1000 }
    this.tokenCache.set(key, entry)
    return entry
  }

  /** Stable key for one user MCP environment. */
  private targetKey(target: UserMcpTarget): string { return `${target.mcpName}\0${target.environment}` }

  /** Dispose every connection and scoped tool owned by one Agent. */
  private async disposeAgent(agent: Agent): Promise<void> {
    this.disposed.add(agent)
    const state = this.agentStates.get(agent)
    if (state === undefined) return
    this.agentStates.delete(agent)
    this.states.delete(state)
    await this.clearAgent(state)
  }

  /** Remove one connection's tools and close its transport. */
  private async closeConnection(connection: ConnectionState): Promise<void> {
    connection.disposers.forEach((dispose) => { dispose() })
    await this.closeClient(connection.client)
  }

  /** Close one MCP client whose transport is discarded regardless of the close outcome. */
  private async closeClient(client: Client): Promise<void> {
    try { await client.close() } catch (_closeError) { /* Nothing depends on a discarded transport closing cleanly. */ }
  }

  /** Close one Agent's user MCP generation. */
  private async clearAgent(state: AgentState): Promise<void> {
    const tasks = [...state.servers.values()].map(connection => this.closeConnection(connection))
    state.servers.clear()
    await Promise.all(tasks)
  }
}
