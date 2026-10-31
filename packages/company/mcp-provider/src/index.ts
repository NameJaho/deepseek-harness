/** Company MCP provider seam and its browser management Remote (`ctx.companyMcp`). */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './provider.ts'
import type {} from '@deepseek-ai/dsh-company-wecom-auth'
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
  static inject = ['companyMcpProvider', 'companyWecomAuth']
  /** @param ctx - Host with a company MCP provider. */
  constructor(ctx: Context) { super(ctx, 'companyMcp', { namespace: 'companyMcp' }) }

  /** Read the current catalog.
   * @returns servers, tools and the latest refresh failure; never endpoints or headers.
   */
  @Remote
  catalog(): Promise<CompanyMcpCatalog> { return this.ctx.companyMcpProvider.catalog(this.ctx.companyWecomAuth.marketSubject()) }

  /** Follow catalog changes.
   * @param signal - subscriber cancellation.
   * @returns the current catalog and one snapshot per change.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<CompanyMcpCatalog> {
    return this.ctx.companyMcpProvider.follow(this.ctx.companyWecomAuth.marketSubject(), signal)
  }

  /** Refresh the catalog; a failed refresh clears inaccessible servers.
   * @param signal - caller cancellation.
   * @returns refreshed catalog or empty catalog with `failure`.
   */
  @Remote
  refresh(signal: AbortSignal): Promise<CompanyMcpCatalog> {
    return this.ctx.companyMcpProvider.refresh(this.ctx.companyWecomAuth.marketSubject(), signal)
  }

  /** Enable or disable one server for this member.
   * @param request - server identity and enablement.
   * @returns updated catalog.
   */
  @Remote
  configure(request: { readonly id: CompanyMcpId; readonly enabled: boolean }): Promise<CompanyMcpCatalog> {
    return this.ctx.companyMcpProvider.configure(this.ctx.companyWecomAuth.marketSubject(), { id: request.id, enabled: request.enabled })
  }

  /** Refresh and read one server's tools.
   * @param request - server identity.
   * @param signal - caller cancellation.
   * @returns current tools with parameters and fingerprints.
   */
  @Remote
  discover(request: { readonly id: CompanyMcpId }, signal: AbortSignal): Promise<readonly CompanyMcpTool[]> {
    return this.ctx.companyMcpProvider.discover(this.ctx.companyWecomAuth.marketSubject(), request.id, signal)
  }
}

export default CompanyMcpRemote
