/** Shared access to the authenticated user MCP catalog, token exchange and per-user MCP connections. */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { z as schema } from 'zod'
import type { Config } from './config.ts'
import type { UserMcpId, UserMcpTarget } from '@deepseek-ai/dsh-company-user-mcp/types'

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

const listToolName = 'queryUserAvailableMcp'

/** Bearer token for one user MCP, valid until `expiresAt` in epoch milliseconds. */
export interface TokenEntry {
  readonly token: string
  readonly resource: string
  readonly expiresAt: number
}

/** One authenticated MCP session and the token that authorizes it. */
export interface UserMcpConnection {
  readonly client: Client
  readonly token: TokenEntry
}

/**
 * Build the failure for a user MCP that could not be initialized.
 * @param target - the user MCP that failed.
 * @param cause - the underlying transport or tool-publication error.
 * @returns a RemoteError carrying the MCP id and the cause.
 */
export function connectFailed(target: UserMcpTarget, cause: unknown): RemoteError<'company-user-mcp/connect-failed'> {
  return new RemoteError('company-user-mcp/connect-failed', 'Could not connect to an authorized MCP server', { mcp: target.id }, { cause })
}

/** Platform HTTP access shared by the Agent bridge and the company MCP provider. */
export class UserMcpClient {
  private readonly tokenCache = new Map<string, TokenEntry>()
  private readonly operations = new Set<Promise<unknown>>()

  /** @param config - validated endpoints, credential names and deadlines. @param lifetime - plugin lifetime; aborts pending exchanges. */
  constructor(private readonly config: Config, private readonly lifetime: AbortSignal) {}

  /**
   * Track an operation so plugin disposal can wait for it.
   * @param operation - work whose settlement is awaited on disposal.
   * @returns the same operation, unchanged.
   */
  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    const done = (): void => { this.operations.delete(operation) }
    void operation.then(done, done)
    return operation
  }

  /** Wait until every tracked operation has settled, successful or not. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.operations])
  }

  /**
   * Query the catalog MCP for one member's authorized user MCPs.
   * @param userId - platform user id of the verified member.
   * @returns authorized targets, capped by `maxServers`.
   * @throws RemoteError `company-user-mcp/missing-credential` or `company-user-mcp/catalog-failed`.
   */
  async list(userId: string): Promise<UserMcpTarget[]> {
    const apiKey = process.env[this.config.listApiKeyEnv]
    if (apiKey === undefined || apiKey.trim() === '') throw new RemoteError('company-user-mcp/missing-credential', 'The user MCP list credential is not configured', {})
    const client = new Client({ name: 'dsh-company-user-mcp-catalog', version: '0.1.0' }, { capabilities: {} })
    const headers = { Authorization: `Bearer ${apiKey}` }
    try {
      const transport = new StreamableHTTPClientTransport(new URL(this.config.listUrl), { requestInit: { headers } })
      await this.track(client.connect(transport, { timeout: this.config.connectionTimeoutMs }))
      const tools = await client.listTools(undefined, { timeout: this.config.connectionTimeoutMs })
      if (!tools.tools.some(tool => tool.name === listToolName)) {
        throw new Error(`catalog MCP does not expose ${listToolName}`)
      }
      const result = await client.callTool({ name: listToolName, arguments: { thirdUid: userId, accessType: 'all', pageNo: 1, pageSize: this.config.maxServers } }, { timeout: this.config.requestTimeoutMs })
      return this.parseCatalogResult(result)
    } catch (error) {
      throw new RemoteError('company-user-mcp/catalog-failed', 'Could not load the authenticated MCP catalog', {}, { cause: error })
    } finally { await this.close(client) }
  }

  /**
   * Exchange a token for one user MCP and open an initialized session on it.
   * @param userId - platform user id of the verified member.
   * @param target - the user MCP to connect.
   * @returns the connected client and the token that authorizes it; the caller closes the client.
   * @throws Error from the token exchange, or RemoteError `company-user-mcp/connect-failed` when the session cannot start.
   */
  async connect(userId: string, target: UserMcpTarget): Promise<UserMcpConnection> {
    const token = await this.exchangeToken(userId, target)
    const client = new Client({ name: 'dsh-company-user-mcp', version: '0.1.0' }, { capabilities: {} })
    try {
      const headers = { Authorization: `Bearer ${token.token}` }
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl(token.resource)), { requestInit: { headers } })
      await this.track(client.connect(transport, { timeout: this.config.connectionTimeoutMs }))
      return { client, token }
    } catch (error) {
      await this.close(client)
      throw connectFailed(target, error)
    }
  }

  /**
   * Read one user MCP's raw tool list in a short-lived session.
   * @param userId - platform user id of the verified member.
   * @param target - the user MCP to inspect.
   * @returns the server's tool descriptors as reported.
   * @throws Error or RemoteError when the exchange, connection or tool listing fails.
   */
  async listTools(userId: string, target: UserMcpTarget): Promise<Tool[]> {
    const { client } = await this.connect(userId, target)
    try {
      const listed = await client.listTools(undefined, { timeout: this.config.connectionTimeoutMs })
      return listed.tools
    } finally { await this.close(client) }
  }

  /**
   * Close one MCP client; its transport is discarded whether or not the close succeeds.
   * @param client - client to close.
   */
  async close(client: Client): Promise<void> {
    try { await client.close() } catch (_closeError) { /* Nothing depends on a discarded transport closing cleanly. */ }
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
      signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(this.config.requestTimeoutMs)]),
    })
    if (!response.ok) { await response.text(); throw new Error(`token exchange failed (${response.status})`) }
    const parsed = tokenResponse.safeParse(await response.json())
    if (!parsed.success) throw new Error('token exchange returned an invalid response')
    const { access_token: token, resource, expires_in: expiresIn } = parsed.data
    const entry: TokenEntry = { token, resource, expiresAt: Date.now() + expiresIn * 1000 }
    this.tokenCache.set(key, entry)
    return entry
  }

  /** Build the MCP endpoint from the token resource without exposing it to callers. */
  private mcpUrl(resource: string): string {
    const url = new URL(resource)
    if (!url.pathname.endsWith('/mcp')) url.pathname = `${url.pathname.replace(/\/$/, '')}/mcp`
    return url.toString()
  }
}
