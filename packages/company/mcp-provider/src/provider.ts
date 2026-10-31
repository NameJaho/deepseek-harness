/** Service Definition for company MCP catalogs and tool execution (`ctx.companyMcpProvider`). */
import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { WecomMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CompanyMcpCapability, CompanyMcpCatalog, CompanyMcpId, CompanyMcpTool, CompanyMcpToolRoute } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The single company MCP provider; loading a second provider throws. */
    companyMcpProvider: CompanyMcpProvider
  }
  interface Events {
    /** Authorized catalog or reported server state changed.
     * @mode emit
     */
    'company-mcp/changed'(): void
  }
}

/** Current schema and executable definition of one model-facing tool. */
export interface CompanyMcpResolvedTool {
  readonly schema: ToolSchema
  readonly tool: ToolDefinition
  readonly fingerprint: string
}

/** Deterministic tool namespace independent of mutable names and catalog order.
 * @param id - stable server identity.
 * @returns `company_` and 12 hex characters.
 */
export function companyMcpNamespace(id: CompanyMcpId): string {
  return `company_${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

/** Model-facing tool name following the MCP client naming convention.
 * @param id - stable server identity.
 * @param rawName - upstream tool name.
 * @returns `[A-Za-z0-9_-]` name of at most 64 characters; lossy normalization appends an identity hash.
 */
export function companyMcpToolName(id: CompanyMcpId, rawName: string): string {
  const namespace = companyMcpNamespace(id)
  const joined = `mcp__${namespace}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${namespace}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

/** Fingerprint pinned by releases.
 * @param schema - model-facing name, description and parameters.
 * @returns SHA-256 hex of the canonical JSON fields.
 */
export function companyMcpFingerprint(schema: ToolSchema): string {
  return createHash('sha256').update(canonical({ name: schema.name, description: schema.description, parameters: schema.parameters })).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Abstract company MCP provider. Exactly one implementation registers as `ctx.companyMcpProvider`.
 *
 * Implementations keep endpoints, headers and tokens private, discard inaccessible data after a failed
 * refresh, report unknown or failed upstream outcomes as failures rather than empty results, and emit
 * `company-mcp/changed` after every observable catalog change.
 */
export abstract class CompanyMcpProvider extends Service {
  /** @param ctx - plugin context owning the provider lifetime. */
  constructor(ctx: Context) { super(ctx, 'companyMcpProvider') }

  /** Read a freshly authorized catalog for one verified member.
   * @param subject - verified request or Session owner, never browser input.
   * @returns authorized servers with state and tools; `loaded` is false before the first successful refresh.
   */
  abstract catalog(subject: WecomMarketSubject): Promise<CompanyMcpCatalog>

  /** Replace the catalog after validating a complete upstream response.
   * @param subject - verified request or Session owner, never browser input.
   * @param signal - caller cancellation.
   * @returns the new catalog, or an empty catalog with `failure` when the refresh failed.
   */
  abstract refresh(subject: WecomMarketSubject, signal?: AbortSignal): Promise<CompanyMcpCatalog>

  /** Refresh and read one server's current tools for display.
   * @param subject - verified request or Session owner, never browser input.
   * @param id - server identity.
   * @param signal - caller cancellation.
   * @returns current tools with parameters and fingerprints.
   * @throws RemoteError when the refresh fails or the server is unknown, disabled or unavailable.
   */
  abstract discover(subject: WecomMarketSubject, id: CompanyMcpId, signal: AbortSignal): Promise<readonly CompanyMcpTool[]>

  /** Read one usable server's tools after fresh authorization for Agent publication.
   * @param subject - verified request or Session owner, never browser input.
   * @param id - server identity selected by an Agent.
   * @returns tools with fingerprints.
   * @throws RemoteError when the server is unauthorized, disabled or unavailable.
   */
  abstract discoverTools(subject: WecomMarketSubject, id: CompanyMcpId): Promise<readonly CompanyMcpTool[]>

  /** Resolve a model-facing tool for one run.
   * @param subject - verified request or Session owner, never browser input.
   * @param name - model-facing tool name.
   * @returns current schema, executable definition and fingerprint, or undefined when no server owns the name.
   * @throws RemoteError when the owning server is disabled or unavailable, or the tool no longer exists.
   */
  abstract resolveTool(subject: WecomMarketSubject, name: string): Promise<CompanyMcpResolvedTool | undefined>

  /** Describe the non-secret route of a model-facing tool.
   * @param subject - verified request or Session owner, never browser input.
   * @param name - model-facing tool name.
   * @returns server, raw tool name, description and fingerprint, or undefined when unknown.
   */
  abstract describeTool(subject: WecomMarketSubject, name: string): Promise<CompanyMcpToolRoute | undefined>

  /** Project the catalog for Agent capability selectors.
   * @param subject - verified request or Session owner, never browser input.
   * @returns server summaries without schemas.
   */
  async capabilityCatalog(subject: WecomMarketSubject): Promise<readonly CompanyMcpCapability[]> {
    return (await this.catalog(subject)).servers.map(server => ({ id: server.id, name: server.name,
      namespace: companyMcpNamespace(server.id), description: server.description, enabled: server.enabled,
      status: server.status, toolNames: server.tools.map(tool => tool.name) }))
  }

  /** Stream catalog snapshots: the current one, then one per `company-mcp/changed`, coalescing bursts.
   * @param subject - verified request or Session owner, never browser input.
   * @param signal - subscriber cancellation.
   * @returns catalog snapshots until the signal aborts.
   */
  async *follow(subject: WecomMarketSubject, signal: AbortSignal): AsyncIterable<CompanyMcpCatalog> {
    let changed = true
    let wake = Promise.withResolvers<void>()
    const notify = (): void => { changed = true; wake.resolve() }
    const stop = this.ctx.on('company-mcp/changed', notify)
    signal.addEventListener('abort', notify, { once: true })
    const aborted = (): boolean => signal.aborted
    try {
      while (!aborted()) {
        if (!changed) await wake.promise
        if (aborted()) return
        changed = false
        wake = Promise.withResolvers<void>()
        yield await this.catalog(subject)
      }
    } finally {
      stop()
      signal.removeEventListener('abort', notify)
    }
  }
}
