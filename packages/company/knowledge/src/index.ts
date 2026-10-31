/** Host-owned approved knowledge sources (`ctx.companyKnowledge`) and owner-side retrieval checks. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-company-wecom-auth'
import { Config } from './config.ts'
import type { KnowledgeSourceConfig } from './config.ts'
import { searchKnowledge } from './search.ts'
import type {
  CompanyKnowledgeBinding, CompanyKnowledgeCatalog, CompanyKnowledgeSearchRequest, CompanyKnowledgeSearchResult, CompanyKnowledgeSource,
} from './types.ts'

export { Config } from './config.ts'
export type { KnowledgeSourceConfig } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Approved knowledge retrieval for Cloud Agents and the owner management page. */
    companyKnowledge: CompanyKnowledgeService
  }
}

interface ResolvedSource {
  readonly config: KnowledgeSourceConfig
  readonly tokenRef: CredentialRef | undefined
}

/** Await a credential lookup without allowing a stopped or timed-out request to linger. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value) }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Approved retrieval registry; public results omit endpoints, credentials and upstream space identities. */
export class CompanyKnowledgeService extends TypertRemoteService {
  static Config = Config
  static inject = ['credentials']
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<CompanyKnowledgeSearchResult>>()
  private readonly sourceMap = new Map<string, ResolvedSource>()

  /** @param ctx - Host with credential storage.
   * @param config - validated sources and retrieval bounds; invalid endpoints or duplicate ids fail at load.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'companyKnowledge', { namespace: 'companyKnowledge' })
    for (const source of config.sources) {
      let url: URL
      try { url = new URL(source.searchUrl) }
      catch (_urlError: unknown) {
        // The configured value may embed credentials, so it is not echoed.
        throw new Error(`Company knowledge source "${source.id}" has an invalid searchUrl`)
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
        throw new Error(`Company knowledge source "${source.id}" requires an HTTP searchUrl without embedded credentials`)
      }
      if (this.sourceMap.has(source.id)) throw new Error(`Company knowledge source id "${source.id}" is duplicated`)
      const tokenRef = source.tokenRef === undefined ? undefined : credentialRef(source.tokenRef)
      this.sourceMap.set(source.id, { config: source, tokenRef })
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Knowledge search service stopped'))
      await Promise.allSettled([...this.active])
    }, 'company-knowledge: active requests')
    ctx.inject(['companyWecomAuth'], (memberCtx) => {
      memberCtx.companyWecomAuth.registerResourceProvider({
        bindings: () => [{ resource: { kind: 'global' }, role: { name: 'company:knowledge', resource: 'global',
          actions: ['companyKnowledge/catalog', 'companyKnowledge/test'] } }],
        sessionOwner: () => undefined,
      })
    })
  }

  /** List configured public-safe sources for authenticated company members and the deployment owner.
   * @returns source names and descriptions, excluding upstream connection settings, and the query length limit.
   */
  @Remote
  catalog(): Promise<CompanyKnowledgeCatalog> {
    return new Promise((resolve) => {
      this.requireMember()
      resolve({ sources: this.sources(), maxQueryChars: this.config.maxQueryChars })
    })
  }

  /** Read source choices from trusted same-process capability consumers.
   * @returns detached public-safe source metadata.
   */
  sources(): CompanyKnowledgeSource[] {
    return this.config.sources.map(({ id, name, description }) => ({ id, name, description }))
  }

  /** Capture one permission fingerprint without exposing its allowed upstream spaces.
   * @param id - configured logical source id.
   * @returns the binding to retain with an Agent release.
   */
  binding(id: string): CompanyKnowledgeBinding {
    const source = this.source(id)
    return { id, fingerprint: createHash('sha256').update(JSON.stringify([...new Set(source.config.spaceIds)].sort())).digest('hex') }
  }

  /** Refuse a release when the source's allowed upstream spaces changed.
   * @param binding - immutable approved source and permission fingerprint.
   */
  validate(binding: CompanyKnowledgeBinding): void {
    if (this.binding(binding.id).fingerprint !== binding.fingerprint) {
      throw new RemoteError('company-knowledge/binding-changed', 'Knowledge source permissions changed; publish a reviewed version',
        { sourceId: binding.id })
    }
  }

  /** Test one configured source from the authenticated retrieval page.
   * @param request - logical source and natural-language query.
   * @param signal - management request cancellation.
   * @returns the retrieved evidence; an upstream failure remains a failure.
   */
  @Remote
  async test(request: CompanyKnowledgeSearchRequest, signal: AbortSignal): Promise<CompanyKnowledgeSearchResult> {
    this.requireMember()
    return await this.search(this.binding(request.sourceId), request.query, signal)
  }

  /** Search only the spaces granted by a trusted release binding.
   * @param binding - source authorization already checked by the calling Agent owner.
   * @param query - untrusted question, validated before dispatch.
   * @param signal - invoking operation cancellation.
   * @returns verified evidence after complete bounded response validation.
   */
  async search(binding: CompanyKnowledgeBinding, query: string, signal: AbortSignal): Promise<CompanyKnowledgeSearchResult> {
    if (this.lifetime.signal.aborted) throw new RemoteError('company-knowledge/unavailable', 'Knowledge service stopped', {})
    this.validate(binding)
    const trimmed = query.trim()
    if (trimmed.length === 0 || trimmed.length > this.config.maxQueryChars) {
      throw new RemoteError('company-knowledge/invalid-input',
        `Enter a question with 1–${String(this.config.maxQueryChars)} characters`, { field: 'query' })
    }
    const pending = this.runSearch(this.source(binding.id), trimmed, signal)
    this.active.add(pending)
    try { return await pending }
    finally { this.active.delete(pending) }
  }

  private source(id: string): ResolvedSource {
    const source = this.sourceMap.get(id)
    if (source === undefined) throw new RemoteError('company-knowledge/not-found', 'Knowledge source is unavailable', { sourceId: id })
    return source
  }

  private async runSearch(source: ResolvedSource, query: string, signal: AbortSignal): Promise<CompanyKnowledgeSearchResult> {
    const upstream = AbortSignal.any([signal, this.lifetime.signal])
    using time = deadline(upstream, this.config.timeoutMs, 'COMPANY_KNOWLEDGE_TIMEOUT')
    try {
      const authorization = await this.authorization(source.tokenRef, time.signal)
      time.signal.throwIfAborted()
      return await searchKnowledge(source.config, query, authorization, this.config, time.signal)
    } catch (error) {
      upstream.throwIfAborted()
      if (timeoutOf(time.signal, 'COMPANY_KNOWLEDGE_TIMEOUT') !== undefined) {
        throw new RemoteError('company-knowledge/search-failed', 'Knowledge search timed out', { reason: 'timeout' }, { cause: error })
      }
      throw error
    }
  }

  private async authorization(ref: CredentialRef | undefined, signal: AbortSignal): Promise<Record<string, string>> {
    if (ref === undefined) return {}
    if (signal.aborted) signal.throwIfAborted()
    let credential: Awaited<ReturnType<Context['credentials']['resolve']>>
    try { credential = await abortable(this.ctx.credentials.resolve(ref), signal) }
    catch (_credentialFailure: unknown) {
      // Credential provider errors can name storage locations; only the classification is reported.
      throw new RemoteError('company-knowledge/search-failed', 'Knowledge search credential is unavailable', { reason: 'credential' })
    }
    if (credential === undefined) return {}
    if (!/^[\x21-\x7e]+$/.test(credential.value)) {
      throw new RemoteError('company-knowledge/search-failed', 'Knowledge search credential is not a valid token', { reason: 'credential' })
    }
    return { authorization: `Bearer ${credential.value}` }
  }

  private requireMember(): void {
    const principal = this.ctx.invocation?.peer.principal
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Direct Host calls have no Remote invocation.
    if (principal !== undefined && principal.kind !== 'owner' && principal.kind !== 'wecom-user' && principal.kind !== 'gateway-user') {
      throw new RemoteError('company-knowledge/owner-required', 'Sign in with an authorized company account to search knowledge sources', {})
    }
  }
}

export default CompanyKnowledgeService
