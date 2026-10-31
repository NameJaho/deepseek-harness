/** Company MCP provider seam and its browser management Remote (`ctx.companyMcp`). */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './provider.ts'
import type { CompanyMcpCatalog, CompanyMcpId, CompanyMcpTool } from './types.ts'

export { CompanyMcpProvider, companyMcpFingerprint, companyMcpNamespace, companyMcpToolName } from './provider.ts'
export type { CompanyMcpResolvedTool } from './provider.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser management Remote over `companyMcpProvider`. */
    companyMcp: CompanyMcpRemote
  }
}

/** Browser-safe catalog reads, refresh, enablement and discovery. */
export class CompanyMcpRemote extends TypertRemoteService {
  static inject = ['companyMcpProvider']
  /** @param ctx - Host with a company MCP provider. */
  constructor(ctx: Context) { super(ctx, 'companyMcp', { namespace: 'companyMcp' }) }

  /** Read the current catalog.
   * @returns servers, tools and the latest refresh failure; never endpoints or headers.
   */
  @Remote
  catalog(): Promise<CompanyMcpCatalog> { return this.ctx.companyMcpProvider.catalog() }

  /** Follow catalog changes.
   * @param signal - subscriber cancellation.
   * @returns the current catalog and one snapshot per change.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<CompanyMcpCatalog> { return this.ctx.companyMcpProvider.follow(signal) }

  /** Refresh the catalog; a failed refresh keeps the previous servers.
   * @param signal - caller cancellation.
   * @returns refreshed catalog or retained catalog with `failure`.
   */
  @Remote
  refresh(signal: AbortSignal): Promise<CompanyMcpCatalog> { return this.ctx.companyMcpProvider.refresh(signal) }

  /** Enable or disable one server for this deployment.
   * @param request - server identity and enablement.
   * @returns updated catalog.
   */
  @Remote
  configure(request: { readonly id: CompanyMcpId; readonly enabled: boolean }): Promise<CompanyMcpCatalog> {
    return this.ctx.companyMcpProvider.configure({ id: request.id, enabled: request.enabled })
  }

  /** Refresh and read one server's tools.
   * @param request - server identity.
   * @param signal - caller cancellation.
   * @returns current tools with parameters and fingerprints.
   */
  @Remote
  discover(request: { readonly id: CompanyMcpId }, signal: AbortSignal): Promise<readonly CompanyMcpTool[]> {
    return this.ctx.companyMcpProvider.discover(request.id, signal)
  }
}

export default CompanyMcpRemote
