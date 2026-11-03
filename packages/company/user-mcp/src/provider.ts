/** Company MCP provider backed by the logged-in member's authorized user MCP catalog. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CompanyMcpProvider, companyMcpFingerprint, companyMcpNamespace, companyMcpToolName, type CompanyMcpResolvedTool } from '@deepseek-ai/dsh-company-mcp-provider'
import type { CompanyMcpCatalog, CompanyMcpErrorCode, CompanyMcpFailure, CompanyMcpId, CompanyMcpServer, CompanyMcpTool, CompanyMcpToolRoute } from '@deepseek-ai/dsh-company-mcp-provider/types'
import type {} from '@deepseek-ai/dsh-company-wecom-auth'
import type { CompanyMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertSupportedJsonSchema, JsonSchemaError, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Tool } from '@modelcontextprotocol/client'
import { Config } from './config.ts'
import { UserMcpClient } from './client.ts'
import type { UserMcpTarget } from '@deepseek-ai/dsh-company-user-mcp/types'

/** A tool found among the member's authorized servers, with the server that owns it. */
type FoundTool = CompanyMcpTool & { readonly serverId: CompanyMcpId }

/** Read the platform user id from a verified WeCom login; portal identities have no WeCom member id.
 * @param subject - verified login or Session owner.
 * @returns the WeCom user id used as the catalog's `thirdUid`.
 * @throws RemoteError `company-mcp/member-unresolved` when the subject has no WeCom identity.
 */
function memberUserId(subject: CompanyMarketSubject): string {
  if (!('sub' in subject) || subject.sub.trim() === '') {
    throw new RemoteError('company-mcp/member-unresolved', 'This login has no WeCom identity for the user MCP catalog; sign in with WeCom', {})
  }
  return subject.sub
}

/** Map a failed catalog read to the browser-safe failure; internal bridge codes never leave the Host. */
function failureOf(error: unknown): CompanyMcpFailure {
  if (error instanceof RemoteError && String(error.code).startsWith('company-mcp/')) {
    return { code: String(error.code) as CompanyMcpErrorCode, message: error.message }
  }
  return { code: 'company-mcp/catalog-unavailable', message: 'MCP catalog is unavailable; refresh to try again' }
}

/** Metadata or value-constraint keywords the Host does not enforce; the MCP server still validates arguments. */
const UNENFORCED_KEYWORDS = new Set(['$schema', '$id', '$comment', 'format', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'contentMediaType', 'readOnly', 'writeOnly'])

/** Remove UNENFORCED_KEYWORDS from every schema node, keeping property names that happen to match them.
 * @param node - raw JSON Schema value from the upstream tool.
 * @returns a copy with those keywords removed; structure and other keywords are unchanged.
 */
function withoutUnenforcedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutUnenforcedKeywords)
  if (node === null || typeof node !== 'object') return node
  const record: Record<string, unknown> = { ...node }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (UNENFORCED_KEYWORDS.has(key)) continue
    const value = record[key]
    out[key] = key === 'properties' || key === 'definitions' ? mapSchemaMap(value) : withoutUnenforcedKeywords(value)
  }
  return out
}

/** Apply withoutUnenforcedKeywords to each named subschema of a `properties` or `definitions` map; names are kept verbatim. */
function mapSchemaMap(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return withoutUnenforcedKeywords(value)
  return Object.fromEntries(Object.entries({ ...value }).map(([name, child]) => [name, withoutUnenforcedKeywords(child)]))
}

/** Build a model-facing tool from one upstream descriptor.
 * @param id - stable server identity used for the namespace.
 * @param tool - upstream descriptor with a JSON Schema input.
 * @returns the display and execution-independent tool fields.
 * @throws RemoteError `company-mcp/invalid-response` when the schema uses unsupported JSON Schema features.
 */
function toCompanyTool(id: CompanyMcpId, tool: Tool): CompanyMcpTool {
  const parameters = withoutUnenforcedKeywords(tool.inputSchema) as Record<string, unknown>
  try { assertSupportedJsonSchema(parameters) } catch (error) {
    const reason = error instanceof JsonSchemaError ? error.violations.join('; ') : 'unsupported-schema'
    throw new RemoteError('company-mcp/invalid-response', 'MCP returned a tool schema DSH cannot use', { reason }, { cause: error })
  }
  const name = companyMcpToolName(id, tool.name)
  const description = tool.description ?? ''
  const schema: ToolSchema = { name, description, parameters }
  return { name, rawName: tool.name, description, parametersJson: JSON.stringify(parameters), fingerprint: companyMcpFingerprint(schema) }
}

/** Browser-safe company MCP provider over the user MCP catalog; tool calls stay unconnected like the Market adapter. */
export default class UserMcpCompanyProvider extends CompanyMcpProvider {
  static inject = ['companyWecomAuth']
  static Config = Config
  private readonly client: UserMcpClient
  private readonly lifetime = new AbortController()

  /** @param ctx - plugin context providing the WeCom identity service and lifetime. @param config - user MCP endpoints and deadlines. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.client = new UserMcpClient(Config(config), this.lifetime.signal)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.client.idle()
    }, 'company-user-mcp-provider: operations')
    ctx.companyWecomAuth.registerResourceProvider({ sessionOwner: () => undefined,
      bindings: () => [{ resource: { kind: 'global' }, role: { name: 'company:mcp', resource: 'global', actions: [
        'companyMcp/catalog', 'companyMcp/follow', 'companyMcp/refresh', 'companyMcp/discover',
      ] } }],
    })
  }

  /** Read the member's authorized user MCPs; failures return an empty, unloaded catalog with `failure`.
   * @param subject - verified login or Session owner.
   * @returns servers without schemas; tools load on discovery.
   */
  async catalog(subject: CompanyMarketSubject): Promise<CompanyMcpCatalog> {
    try {
      const targets = await this.client.list(memberUserId(subject))
      return { loaded: true, servers: targets.map(toServer), refreshedAt: Date.now() }
    } catch (error) {
      if (this.lifetime.signal.aborted) throw error
      return { loaded: false, servers: [], failure: failureOf(error) }
    }
  }

  /** Re-read the catalog and announce the change to followers.
   * @param subject - verified login or Session owner.
   * @returns the refreshed catalog.
   */
  async refresh(subject: CompanyMarketSubject): Promise<CompanyMcpCatalog> {
    const catalog = await this.catalog(subject)
    this.ctx.emit('company-mcp/changed')
    return catalog
  }

  /** Read one authorized server's tools.
   * @param subject - verified login or Session owner.
   * @param id - server identity from the catalog.
   * @returns tools with parameters and fingerprints.
   * @throws RemoteError `company-mcp/not-found` when the member has no such server, or a tool-listing failure.
   */
  async discover(subject: CompanyMarketSubject, id: CompanyMcpId): Promise<readonly CompanyMcpTool[]> {
    const userId = memberUserId(subject)
    const target = (await this.client.list(userId)).find(entry => serverIdOf(entry) === id)
    if (target === undefined) throw new RemoteError('company-mcp/not-found', 'The MCP is not available to this member', { id })
    return this.toolsOf(userId, target)
  }

  /**
   * Read one usable server's tools for Agent publication.
   * @param subject - verified login or Session owner.
   * @param id - server identity.
   * @returns tools with fingerprints.
   */
  discoverTools(subject: CompanyMarketSubject, id: CompanyMcpId): Promise<readonly CompanyMcpTool[]> {
    return this.discover(subject, id)
  }

  /** Resolve a model-facing tool name to its current schema and definition.
   * @param subject - verified login or Session owner.
   * @param name - model-facing tool name.
   * @returns the current schema, definition and fingerprint, or undefined when no authorized server owns the name.
   */
  async resolveTool(subject: CompanyMarketSubject, name: string): Promise<CompanyMcpResolvedTool | undefined> {
    const found = await this.findTool(subject, name)
    if (found === undefined) return undefined
    const parameters = JSON.parse(found.parametersJson) as Record<string, unknown>
    const schema: ToolSchema = { name, description: found.description, parameters }
    const definition: ToolDefinition = { ...schema,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: () => Promise.reject(new RemoteError('company-mcp/call-unavailable',
        'MCP invocation is not connected; this integration currently provides the member directory and tool discovery', {})),
    }
    return { schema, fingerprint: found.fingerprint, tool: definition }
  }

  /** Describe the non-secret route of a model-facing tool.
   * @param subject - verified login or Session owner.
   * @param name - model-facing tool name.
   * @returns server, raw tool name, description and fingerprint, or undefined when unknown.
   */
  async describeTool(subject: CompanyMarketSubject, name: string): Promise<CompanyMcpToolRoute | undefined> {
    const found = await this.findTool(subject, name)
    if (found === undefined) return undefined
    return { serverId: found.serverId, rawName: found.rawName, description: found.description, fingerprint: found.fingerprint }
  }

  /** Find a tool among the member's authorized servers by its model-facing name. */
  private async findTool(subject: CompanyMarketSubject, name: string): Promise<FoundTool | undefined> {
    const userId = memberUserId(subject)
    for (const target of await this.client.list(userId)) {
      const id = serverIdOf(target)
      if (!name.startsWith(`mcp__${companyMcpNamespace(id)}__`)) continue
      const tool = (await this.toolsOf(userId, target)).find(entry => entry.name === name)
      return tool === undefined ? undefined : { ...tool, serverId: id }
    }
    return undefined
  }

  /** Read and convert one server's tools. */
  private async toolsOf(userId: string, target: UserMcpTarget): Promise<readonly CompanyMcpTool[]> {
    const id = serverIdOf(target)
    return (await this.client.listTools(userId, target)).map(tool => toCompanyTool(id, tool))
  }
}

/** Stable company MCP identity for one user MCP. */
function serverIdOf(target: UserMcpTarget): CompanyMcpId {
  return brandString<CompanyMcpId>(String(target.id))
}

/** Catalog summary without schemas; the Host serves tools only on discovery. */
function toServer(target: UserMcpTarget): CompanyMcpServer {
  return { id: serverIdOf(target), name: target.displayName, description: target.description, enabled: true, status: 'available', tools: [] }
}
