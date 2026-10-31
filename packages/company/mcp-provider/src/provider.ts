/** Service Definition for company MCP catalogs and tool execution (`ctx.companyMcpProvider`). */
import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CompanyMcpCapability, CompanyMcpCatalog, CompanyMcpId, CompanyMcpTool, CompanyMcpToolRoute } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The single company MCP provider; loading a second provider throws. */
    companyMcpProvider: CompanyMcpProvider
  }
  interface Events {
    /** Catalog, enablement or reported server state changed.
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
  return createHash('sha256').update(JSON.stringify({ name: schema.name, description: schema.description,
    parameters: schema.parameters })).digest('hex')
}

/**
 * Abstract company MCP provider. Exactly one implementation registers as `ctx.companyMcpProvider`.
 *
 * Implementations keep endpoints, headers and tokens private, keep the last successful catalog after a failed
 * refresh, report unknown or failed upstream outcomes as failures rather than empty results, and emit
 * `company-mcp/changed` after every observable catalog change.
 */
export abstract class CompanyMcpProvider extends Service {
  /** @param ctx - plugin context owning the provider lifetime. */
  constructor(ctx: Context) { super(ctx, 'companyMcpProvider') }

  /** Read the current catalog without contacting the upstream.
   * @returns servers with enablement, state and tools; `loaded` is false before the first successful refresh.
   */
  abstract catalog(): Promise<CompanyMcpCatalog>

  /** Replace the catalog after validating a complete upstream response.
   * @param signal - caller cancellation.
   * @returns the new catalog, or the retained catalog with `failure` when the refresh failed.
   */
  abstract refresh(signal?: AbortSignal): Promise<CompanyMcpCatalog>

  /** Persist whether one server may be used; credentials are deployment configuration, not preferences.
   * @param request - server identity and enablement.
   * @returns the updated catalog.
   * @throws RemoteError `company-mcp/not-found` for an unknown server.
   */
  abstract configure(request: { readonly id: CompanyMcpId; readonly enabled: boolean }): Promise<CompanyMcpCatalog>

  /** Refresh and read one server's current tools for display.
   * @param id - server identity.
   * @param signal - caller cancellation.
   * @returns current tools with parameters and fingerprints.
   * @throws RemoteError when the refresh fails or the server is unknown, disabled or unavailable.
   */
  abstract discover(id: CompanyMcpId, signal: AbortSignal): Promise<readonly CompanyMcpTool[]>

  /** Read one usable server's tools from the current catalog for Agent publication.
   * @param id - server identity selected by an Agent.
   * @returns tools with fingerprints.
   * @throws RemoteError when the catalog is not loaded or the server is unknown, disabled or unavailable.
   */
  abstract discoverTools(id: CompanyMcpId): Promise<readonly CompanyMcpTool[]>

  /** Resolve a model-facing tool for one run.
   * @param name - model-facing tool name.
   * @returns current schema, executable definition and fingerprint, or undefined when no server owns the name.
   * @throws RemoteError when the owning server is disabled or unavailable, or the tool no longer exists.
   */
  abstract resolveTool(name: string): Promise<CompanyMcpResolvedTool | undefined>

  /** Describe the non-secret route of a model-facing tool.
   * @param name - model-facing tool name.
   * @returns server, raw tool name, description and fingerprint, or undefined when unknown.
   */
  abstract describeTool(name: string): Promise<CompanyMcpToolRoute | undefined>

  /** Project the catalog for Agent capability selectors.
   * @returns server summaries without schemas.
   */
  async capabilityCatalog(): Promise<readonly CompanyMcpCapability[]> {
    return (await this.catalog()).servers.map(server => ({ id: server.id, name: server.name,
      namespace: companyMcpNamespace(server.id), description: server.description, enabled: server.enabled,
      status: server.status, toolNames: server.tools.map(tool => tool.name) }))
  }

  /** Stream catalog snapshots: the current one, then one per `company-mcp/changed`, coalescing bursts.
   * @param signal - subscriber cancellation.
   * @returns catalog snapshots until the signal aborts.
   */
  async *follow(signal: AbortSignal): AsyncIterable<CompanyMcpCatalog> {
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
        yield await this.catalog()
      }
    } finally {
      stop()
      signal.removeEventListener('abort', notify)
    }
  }
}
