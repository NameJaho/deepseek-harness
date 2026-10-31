/** Official WeCom login and durable credential-free browser sessions. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { BrowserPrincipalRegistration, BrowserSessionKey, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessAction, RemoteAccessBinding, RemoteAccessCondition, RemoteAccessDecision } from '@deepseek-ai/dsh-api-remote-access/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CompanyOwnerScope, CompanyUserPrincipal, WecomResourceProvider, CompanyMarketSubject, PortalUserId } from './types.ts'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { Config } from './config.ts'
import { wecomAuthDomain, type WecomSessionRecord } from './storage.ts'
import type { GatewayUserPrincipal, WecomCorpId, WecomIdentityId, WecomLoginAttemptId, WecomLoginConfig, WecomLoginResult, WecomSessionId, WecomSessionView, WecomUserId, WecomUserRole } from './types.ts'
import { BROWSER_COOKIE, SESSION_COOKIE, cookie, cookieHeader, hash, hashMatches, header, readCookie, safeRedirect, signCookie } from './browser.ts'
import { WecomAuthError } from './errors.ts'
import { WecomOfficial, type WecomMemberLogin } from './upstream.ts'
import { loginPage } from './login-page.ts'
import { accountPage } from './account-page.ts'

export { Config } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Official WeCom browser authentication; no app token or secret is exposed. */
    companyWecomAuth: CompanyWecomAuthService
  }
}

interface State { readonly domain: Domain<typeof wecomAuthDomain>; readonly secret: Buffer }
interface GatewayIdentity { readonly principal: GatewayUserPrincipal; readonly workspace?: Workspace }
const SECRET = credentialKey('company-wecom-official-auth', 'cookie-secret')
const DEFAULT_WECOM_ROLE: WecomUserRole = 'user'
const SESSION_ACTIONS: readonly RemoteAccessAction[] = ['session/list', 'session/search', 'session/control', 'session/page',
  'session/follow', 'session/projections', 'session/prompt', 'session/cancel', 'session/rename', 'session/selectModel',
  'session/updateQueue', 'session/attachment', 'fileUploads/upload', 'skills/list', 'commands/list',
  'workspace/follow', 'workspace/archiveSession', 'workspace/unarchiveSession', 'workspace/pinSession', 'workspace/unpinSession',
  'workspace/insertSessionBefore', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'workspaceFiles/list',
  'workspaceFiles/changes', 'event:api-session/added', 'event:api-session/removed', 'event:api-session/status',
  'event:api-session/error', 'event:api-session/activity']
const grantedCommand = ({ args }: Parameters<RemoteAccessCondition<'session'>>[0]): RemoteAccessDecision =>
  args === undefined || (typeof args.line === 'string' && /^\/(?:permission|compact|goal|plan)(?:\s|$)/u.test(args.line))
    ? { kind: 'allow' } : { kind: 'deny', reason: 'command-not-granted' }
const exchangeSchema = z.object({
  state: z.string().max(200).regex(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(4096),
}).strict()

/** Required browser login; local revocation stops admission before durable writes. */
export class CompanyWecomAuthService extends Service {
  static inject = ['credentials', 'storageDomain', 'connection', 'webServer', 'remoteAccess', 'workspaceRegistry']
  static Config = Config
  private readonly config: Config
  private readonly workspaceRoot: string
  private readonly lifetime = new AbortController()
  private readonly upstream: WecomOfficial
  private state: State | undefined
  private registration: BrowserPrincipalRegistration | undefined
  private readonly active = new Set<Promise<unknown>>()
  private readonly consuming = new Set<WecomLoginAttemptId>()
  private pendingAttempts = 0
  private readonly revoked = new Set<WecomSessionId>()
  private readonly workspaces = new Map<WecomIdentityId, Workspace>()
  private readonly workspaceRoots = new Map<WecomIdentityId, string>()
  private readonly gatewayIdentities = new Map<WecomIdentityId, GatewayIdentity>()
  private readonly gatewayProvisioning = new Map<WecomIdentityId, Promise<void>>()
  private readonly gatewayDiagnostics = new Set<string>()
  private readonly resources = new Set<WecomResourceProvider>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /** @param owner - Host HTTP, cookie-key and domain providers.
   * @param config - public application identifiers, HTTPS origin and limits.
   * @throws Error when identifiers, origin or the server app-secret environment are missing or invalid.
   */
  constructor(private readonly owner: Context, config: Config) {
    super(owner, 'companyWecomAuth')
    this.config = Config(config)
    this.config.workspaceRoot ??= join(process.cwd(), '.dsh-wecom-workspaces')
    if (!isAbsolute(this.config.workspaceRoot)) {
      throw new Error('wecom-auth: workspaceRoot must be an absolute path')
    }
    this.workspaceRoot = resolve(this.config.workspaceRoot)
    const origin = new URL(this.config.publicOrigin)
    if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
      || origin.search !== '' || origin.hash !== '') throw new Error('wecom-auth: publicOrigin must be a bare HTTPS origin')
    this.config.publicOrigin = origin.origin
    if (this.config.gatewayLogoutUrl !== '') {
      const logout = new URL(this.config.gatewayLogoutUrl)
      if (!['http:', 'https:'].includes(logout.protocol)) throw new Error('wecom-auth: gatewayLogoutUrl must use HTTP or HTTPS')
    }
    if (this.config.gatewayIdentityEnabled && this.config.gatewayLogoutUrl === '') {
      throw new Error('wecom-auth: gatewayLogoutUrl is required when gatewayIdentityEnabled is enabled')
    }
    this.diagnostic('gateway identity diagnostics enabled')
    const secret = process.env.DSH_WECOM_APP_SECRET
    if (secret === undefined || secret.trim() === '') throw new Error('wecom-auth: set DSH_WECOM_APP_SECRET in the server environment')
    this.upstream = new WecomOfficial(this.config, secret, this.lifetime.signal)
    owner.effect(() => async () => {
      this.lifetime.abort()
      clearTimeout(this.timer)
      await this.registration?.dispose()
      await Promise.allSettled([...this.active])
      await this.state?.domain.close()
    }, 'wecom-auth: requests, Peers and domain')
  }

  /** Register admission only after validating durable cookie and session records. */
  async [Service.init](): Promise<void> {
    const domain = await this.owner.storageDomain.open(wecomAuthDomain)
    try {
      const stored = await this.owner.credentials.modifyRecord(SECRET, current => Promise.resolve(current === undefined
        ? { kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('base64url') } } : undefined))
      const parsed = stored?.kind === 'grant' ? z.object({ version: z.literal(1), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict().safeParse(stored.payload) : undefined
      if (parsed?.success !== true) throw new Error('wecom-auth: invalid cookie signing key; restore the credential provider backup')
      for (const [id, session] of domain.table('sessions').entries()) {
        if (id !== session.id || domain.table('identities').get(session.identityId) === undefined) {
          throw new Error('wecom-auth: invalid stored session identity; restore the storage backup')
        }
      }
      this.state = { domain, secret: Buffer.from(parsed.data.secret, 'base64url') }
    } catch (error) { await domain.close(); throw error }
    const remoteAccess = this.owner.get('remoteAccess')
    const workspaceRegistry = this.owner.get('workspaceRegistry')
    if (remoteAccess !== undefined && workspaceRegistry !== undefined) {
      for (const [, identity] of this.state.domain.table('identities').entries()) {
        if (identity.enabled && identity.corpId === this.config.corpId) await this.ensureWorkspace(identity.id)
      }
      remoteAccess.registerPolicy('wecom-user', { bindings: principal => this.bindings(principal) })
      remoteAccess.registerPolicy('gateway-user', { bindings: principal => this.bindings(principal) })
      this.owner.on('domain/changed', (change) => {
        if (change.domain === 'workspace') remoteAccess.invalidate()
      })
    }
    this.registration = this.owner.connection.registerBrowserPrincipalProvider({
      loginPath: '/login', requireLogin: true,
      authenticate: (request) => {
        const gateway = this.gatewayPrincipal(request)
        if (gateway !== undefined) return { sessionKey: brandString<BrowserSessionKey>(`gateway-${gateway.identityId}`), principal: gateway }
        const session = this.current(request)
        const identity = session === undefined ? undefined : this.state?.domain.table('identities').get(session.identityId)
        if (session === undefined || identity === undefined) return undefined
        return { sessionKey: brandString<BrowserSessionKey>(session.id), principal: {
          kind: 'wecom-user', identityId: identity.id, corpId: identity.corpId, userId: identity.userId, role: DEFAULT_WECOM_ROLE,
        } }
      },
    })
    this.owner.on('webserver/index-inject', (table, peer) => {
      if (peer.principal.kind === 'gateway-user') {
        table.push({ kind: 'global', name: '__DSH_WECOM_SESSION__', value: {
          identityId: peer.principal.identityId, corpId: 'gateway', userId: peer.principal.userId,
          displayName: peer.principal.displayName, role: peer.principal.role,
        } })
        return
      }
      if (peer.principal.kind !== 'wecom-user') return
      const identity = this.state?.domain.table('identities').get(peer.principal.identityId)
      if (identity !== undefined) table.push({ kind: 'global', name: '__DSH_WECOM_SESSION__', value: {
        identityId: identity.id, corpId: identity.corpId, userId: identity.userId, displayName: identity.displayName,
        role: DEFAULT_WECOM_ROLE,
      } })
    })
    for (const path of ['/login', '/auth/wecom/callback', '/auth/wecom/logout', '/auth/me']) {
      this.owner.effect(() => this.owner.webServer.register({ kind: 'exact', path,
        handler: (request, response) => this.track(this.handle(path, request, response)),
      }), `wecom-auth: ${path}`)
    }
    this.scheduleExpiry()
  }

  /** Register business grants in the calling plugin's lifecycle.
   * @param provider - committed resource ownership and explicit action grants.
   * @returns a disposer removing all grants contributed by this provider.
   */
  registerResourceProvider(provider: WecomResourceProvider): () => Promise<void> {
    return this.ctx.effect(() => {
      this.resources.add(provider)
      this.owner.get('remoteAccess')?.invalidate()
      return () => { this.resources.delete(provider); this.owner.get('remoteAccess')?.invalidate() }
    }, 'wecom-auth: business resource grants')
  }

  /** Build ordinary conversation and Workspace grants for business-owned Sessions.
   * @param ids - Session identities already authorized by the calling business provider.
   * @returns explicit user operations; deployment settings, filesystem mutation and native openers are excluded.
   */
  sessionBindings(ids: readonly SessionId[]): RemoteAccessBinding[] {
    const bindings: RemoteAccessBinding[] = [{ role: { name: 'company:browser', resource: 'global', actions: [
      'session/list', 'session/search', 'session/control', 'session/modelCatalog', 'workspace/follow', 'permissionPresets/catalog',
    ] }, resource: { kind: 'global' } }]
    for (const id of ids) {
      bindings.push({ role: { name: 'company:conversation', resource: 'session', actions: SESSION_ACTIONS }, resource: { kind: 'session', id } })
      bindings.push({ role: { name: 'company:conversation-command', resource: 'session', actions: ['commands/execute'] },
        resource: { kind: 'session', id }, condition: grantedCommand })
    }
    const owned = new Set(ids)
    for (const workspace of this.owner.get('workspaceRegistry')?.list() ?? []) {
      if (workspace.sessionIds.length > 0 && workspace.sessionIds.every(id => owned.has(id))) bindings.push({
        role: { name: 'company:workspace', resource: 'workspace', actions: ['workspace/follow', 'workspace/insertSessionBefore'] },
        resource: { kind: 'workspace', id: workspace.id },
      })
    }
    return bindings
  }

  /** Resolve the current Remote caller or trusted tool initiator's company ownership scope.
   * @param member - authenticated company principal from an access-policy dispatch; omission resolves the caller.
   * @returns stable enterprise scope, or `local-owner` outside an enterprise call or initiating Session.
   * @throws WecomAuthError for unsupported non-owner principals.
   */
  ownerScope(member?: CompanyUserPrincipal): CompanyOwnerScope {
    const principal = member ?? this.ctx.invocation?.peer.principal
    if (principal?.kind === 'wecom-user') return brandString<CompanyOwnerScope>(`wecom:${principal.corpId}:${principal.userId}`)
    if (principal?.kind === 'gateway-user') return brandString<CompanyOwnerScope>(`gateway:${principal.userId}`)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal !== undefined && principal.kind !== 'owner') throw new WecomAuthError('wecom-auth/forbidden', 403)
    if (principal === undefined) {
      const agent = this.owner.get('agents')?.currentInitiator()
      const scope = agent === undefined ? undefined : this.sessionOwner(agent.id)
      if (scope !== undefined) return scope
    }
    return brandString<CompanyOwnerScope>('local-owner')
  }

  /** Read the current member's default Workspace Session identities for business grants.
   * @param principal - authenticated member supplied by the access-policy dispatcher.
   * @returns owned Session identities; unknown or mismatched identities return an empty list.
   */
  defaultWorkspaceSessions(principal: CompanyUserPrincipal): readonly SessionId[] {
    if (principal.kind === 'gateway-user') {
      if (this.gatewayIdentities.get(principal.identityId)?.principal.userId !== principal.userId) return []
    } else {
      const identity = this.state?.domain.table('identities').get(principal.identityId)
      if (identity?.corpId !== principal.corpId || identity.userId !== principal.userId) return []
    }
    const workspace = this.workspaces.get(principal.identityId)
    return workspace === undefined ? [] : [...this.owner.get('workspaceRegistry')?.get(workspace.id)?.sessionIds ?? []]
  }

  /** Resolve retained ownership for a member default Workspace or business-owned Session.
   * @param sessionId - tool-initiating or source Session identity.
   * @returns stable owner, or undefined when no provider retains ownership; logout does not transfer ownership.
   */
  sessionOwner(sessionId: SessionId): CompanyOwnerScope | undefined {
    const registry = this.owner.get('workspaceRegistry')
    for (const [identityId, workspace] of this.workspaces) {
      if (registry?.get(workspace.id)?.sessionIds.includes(sessionId) !== true) continue
      const gateway = this.gatewayIdentities.get(identityId)
      if (gateway !== undefined) return this.ownerScope(gateway.principal)
      const identity = this.state?.domain.table('identities').get(identityId)
      if (identity !== undefined) return brandString<CompanyOwnerScope>(`wecom:${identity.corpId}:${identity.userId}`)
    }
    for (const provider of this.resources) {
      const scope = provider.sessionOwner(sessionId)
      if (scope !== undefined) return scope
    }
    return undefined
  }

  /** Parse one trusted portal identity and start its Workspace provisioning.
   * @param request - request headers supplied by the trusted reverse proxy.
   * @returns gateway principal, or undefined when the feature is disabled or the header is invalid.
   */
  private gatewayPrincipal(request: ConnectionTrustRequest): GatewayUserPrincipal | undefined {
    if (!this.config.gatewayIdentityEnabled) return undefined
    const encoded = header(request, 'x-user-info')
    if (encoded === undefined) {
      this.gatewayDiagnostic('missing-header', 'gateway X-User-Info header missing')
      return undefined
    }
    if (encoded.length > 16_384) {
      this.gatewayDiagnostic('header-too-large', 'gateway X-User-Info header exceeds 16 KiB')
      return undefined
    }
    let input: unknown
    try { input = JSON.parse(decodeURIComponent(encoded)) }
    catch (_invalidGatewayIdentity) {
      this.gatewayDiagnostic('invalid-json', 'gateway X-User-Info header is not URL-encoded JSON')
      return undefined
    }
    const parsed = z.object({ userId: z.string().trim().min(1).max(256), userName: z.string().trim().min(1).max(256) })
      .loose().safeParse(input)
    if (!parsed.success) {
      this.gatewayDiagnostic('invalid-fields', 'gateway X-User-Info is missing a valid userId or userName')
      return undefined
    }
    const identityId = brandString<WecomIdentityId>(`i-${createHash('sha256').update(`gateway:${parsed.data.userId}`).digest('hex')}`)
    const principal: GatewayUserPrincipal = { kind: 'gateway-user', identityId,
      userId: brandString<WecomUserId>(parsed.data.userId), displayName: parsed.data.userName, role: DEFAULT_WECOM_ROLE }
    const current = this.gatewayIdentities.get(identityId)
    this.gatewayIdentities.set(identityId, { principal, ...(current?.workspace === undefined ? {} : { workspace: current.workspace }) })
    if (current === undefined) {
      this.diagnostic(`gateway identity received userId=${parsed.data.userId} userName=${parsed.data.userName}`)
      this.provisionGatewayIdentity(identityId)
    }
    return principal
  }

  private gatewayDiagnostic(key: string, message: string): void {
    if (this.gatewayDiagnostics.has(key)) return
    this.gatewayDiagnostics.add(key)
    this.diagnostic(message)
  }

  /** Web profiles mount no logger exporter, so diagnostics also go to stdout, which the launcher writes to dsh.log. */
  private diagnostic(message: string): void {
    if (!this.config.gatewayIdentityEnabled) return
    this.owner.logger.info(`wecom-auth: ${message}`)
    process.stdout.write(`wecom-auth: ${message}\n`)
  }

  private provisionGatewayIdentity(identityId: WecomIdentityId): void {
    if (this.gatewayProvisioning.has(identityId)) return
    const task = this.ensureWorkspace(identityId).then((workspace) => {
      if (workspace === undefined) return
      const identity = this.gatewayIdentities.get(identityId)
      if (identity !== undefined) this.gatewayIdentities.set(identityId, { ...identity, workspace })
      this.owner.get('remoteAccess')?.invalidate()
    }).finally(() => { this.gatewayProvisioning.delete(identityId) })
    this.gatewayProvisioning.set(identityId, task)
    void task.catch((error: unknown) => { this.owner.logger.warn(`wecom-auth: gateway Workspace provisioning failed: ${String(error)}`) })
  }

  /** Resolve the verified company identity for a request or an owned Session.
   * @param sessionId - trusted execution Session; omission uses the Remote caller or tool initiator.
   * @returns official WeCom identity or trusted portal identity; neither contains credentials.
   * @throws WecomAuthError when no active company identity owns the operation.
   */
  marketSubject(sessionId?: SessionId): CompanyMarketSubject {
    const principal = this.ctx.invocation?.peer.principal
    if (sessionId === undefined && principal?.kind === 'gateway-user') {
      const member = this.gatewayIdentities.get(principal.identityId)?.principal
      if (member?.userId !== principal.userId) throw new WecomAuthError('wecom-auth/forbidden', 403)
      return { scope: this.ownerScope(member), portalUserId: brandString<PortalUserId>(member.userId), displayName: member.displayName }
    }
    if (sessionId === undefined && principal?.kind === 'wecom-user') {
      const identity = this.state?.domain.table('identities').get(principal.identityId)
      if (identity?.enabled === true && identity.corpId === this.config.corpId
        && identity.corpId === principal.corpId && identity.userId === principal.userId) {
        return { scope: this.ownerScope(principal), corpId: identity.corpId, sub: identity.userId }
      }
      throw new WecomAuthError('wecom-auth/forbidden', 403)
    }
    if (sessionId === undefined && principal !== undefined && principal.kind !== 'owner') {
      throw new WecomAuthError('wecom-auth/forbidden', 403)
    }
    const id = sessionId ?? this.owner.get('agents')?.currentInitiator()?.id
    const scope = id === undefined ? undefined : this.sessionOwner(id)
    for (const { principal: member } of this.gatewayIdentities.values()) {
      if (scope === `gateway:${member.userId}`) return { scope, portalUserId: brandString<PortalUserId>(member.userId), displayName: member.displayName }
    }
    for (const [, identity] of this.state?.domain.table('identities').entries() ?? []) {
      if (identity.enabled && identity.corpId === this.config.corpId && scope === `wecom:${identity.corpId}:${identity.userId}`) {
        return { scope, corpId: identity.corpId, sub: identity.userId }
      }
    }
    throw new WecomAuthError('wecom-auth/forbidden', 403)
  }

  /** Begin a durable, browser-bound, single-use login attempt.
   * @param request - trusted request authority.
   * @param browserNonce - random HttpOnly browser binding.
   * @param redirect - site-local requested destination; unsafe destinations become `/`.
   * @returns public identifiers, callback URI and unpredictable state.
   */
  async beginLogin(request: ConnectionTrustRequest, browserNonce: string, redirect: string | null): Promise<WecomLoginConfig> {
    this.authority(request)
    const state = this.requireState()
    const attempts = state.domain.table('attempts')
    for (const [id, attempt] of attempts.entries()) if (attempt.expiresAt <= Date.now()) {
      await attempts.delete(id)
      this.consuming.delete(id)
    }
    if ([...attempts.entries()].length + this.pendingAttempts >= this.config.maxLoginAttempts) throw new WecomAuthError('wecom-auth/unavailable', 429)
    this.pendingAttempts++
    try {
      const id = brandString<WecomLoginAttemptId>(randomUUID())
      const rawState = `${id}.${randomBytes(32).toString('base64url')}`
      const now = Date.now()
      const corpId = brandString<WecomLoginConfig['corpId']>(this.config.corpId)
      await attempts.put(id, { id, stateHash: hash(rawState), browserHash: hash(browserNonce), corpId,
        agentId: this.config.agentId, browserAuthority: this.config.publicOrigin, createdAt: now,
        expiresAt: now + this.config.loginAttemptTtlMs, redirectPath: safeRedirect(redirect, ['/']) })
      return { corpId, agentId: this.config.agentId, attemptId: id, state: rawState,
        expiresAt: now + this.config.loginAttemptTtlMs, redirectUri: `${this.config.publicOrigin}/auth/wecom/callback` }
    } finally { this.pendingAttempts-- }
  }

  /** Consume state before exchanging the code with official APIs.
   * @param request - callback headers including the initiating browser cookie.
   * @param input - untrusted callback fields.
   * @returns persisted member session and signed cookie; failures require a fresh login.
   */
  async exchange(request: ConnectionTrustRequest, input: unknown): Promise<WecomLoginResult & { readonly cookie: string }> {
    this.authority(request)
    const parsed = exchangeSchema.safeParse(input)
    if (!parsed.success) throw new WecomAuthError('wecom-auth/invalid-request', 400)
    const state = this.requireState()
    const id = brandString<WecomLoginAttemptId>(parsed.data.state.slice(0, 36))
    const attempt = state.domain.table('attempts').get(id)
    const nonce = cookie(request, BROWSER_COOKIE)
    if (attempt === undefined || this.consuming.has(id) || attempt.consumedAt !== undefined || attempt.expiresAt <= Date.now()
      || attempt.browserAuthority !== this.config.publicOrigin || attempt.corpId !== this.config.corpId
      || attempt.agentId !== this.config.agentId || nonce === undefined
      || !hashMatches(parsed.data.state, attempt.stateHash) || !hashMatches(nonce, attempt.browserHash)) {
      throw new WecomAuthError('wecom-auth/expired', 400)
    }
    this.consuming.add(id)
    await state.domain.table('attempts').put(id, { ...attempt, consumedAt: Date.now() })
    return this.establish(request, await this.upstream.exchange(parsed.data.code), attempt.redirectPath)
  }

  private async establish(
    request: ConnectionTrustRequest, login: WecomMemberLogin, redirect: string,
  ): Promise<WecomLoginResult & { readonly cookie: string }> {
    const state = this.requireState()
    this.lifetime.signal.throwIfAborted()
    const identityId = brandString<WecomIdentityId>(`i-${hash(JSON.stringify([login.corpId, login.userId]))}`)
    if (state.domain.table('identities').get(identityId)?.enabled === false) throw new WecomAuthError('wecom-auth/disabled', 403)
    const now = Date.now()
    const identity = { id: identityId, ...login, departments: [...login.departments], enabled: true, lastLoginAt: now }
    const id = brandString<WecomSessionId>(`s-${randomUUID()}`)
    const session: WecomSessionRecord = { id, identityId, agentId: this.config.agentId, browserAuthority: this.config.publicOrigin,
      issuedAt: now, expiresAt: now + this.config.sessionTtlMs, lastSeenAt: now }
    await this.ensureWorkspace(identityId)
    const previous = this.current(request)
    if (previous !== undefined) await this.revoke(previous)
    await state.domain.table('identities').put(identityId, identity)
    await state.domain.table('sessions').put(id, session)
    this.owner.get('remoteAccess')?.invalidate()
    this.scheduleExpiry()
    this.diagnostic(`WeCom login received userId=${login.userId} userName=${login.displayName ?? '<missing>'}`)
    return { session: { identityId, ...login, role: DEFAULT_WECOM_ROLE, expiresAt: session.expiresAt }, redirect,
      cookie: cookieHeader(SESSION_COOKIE, signCookie({ version: 1, sessionId: id, authority: this.config.publicOrigin,
        issuedAt: now, expiresAt: session.expiresAt }, state.secret), true, this.config.sessionTtlMs, '/') }
  }

  /** Resolve only enabled, unexpired, unrevoked local sessions for this deployment.
   * @param request - browser cookie and authority.
   * @returns credential-free member view, or null when admission is denied.
   */
  getCurrentSession(request: ConnectionTrustRequest): WecomSessionView | null {
    const gateway = this.gatewayPrincipal(request)
    if (gateway !== undefined) return { identityId: gateway.identityId, corpId: brandString<WecomCorpId>('gateway'),
      userId: gateway.userId, role: gateway.role, displayName: gateway.displayName, expiresAt: Date.now() + this.config.sessionTtlMs,
      ...this.config.gatewayLogoutUrl === '' ? {} : { logoutUrl: this.config.gatewayLogoutUrl } }
    const session = this.current(request)
    const identity = session === undefined ? undefined : this.state?.domain.table('identities').get(session.identityId)
    return identity === undefined || session === undefined ? null : { identityId: identity.id, corpId: identity.corpId,
      userId: identity.userId, role: DEFAULT_WECOM_ROLE, ...identity.displayName === undefined ? {} : { displayName: identity.displayName },
      expiresAt: session.expiresAt }
  }

  /** Revoke the local session and its Peer's streams before persistence.
   * @param request - browser cookie; absent or invalid cookies are harmless.
   * @returns completed durable revocation; storage failure keeps in-process admission denied.
   */
  async logout(request: ConnectionTrustRequest): Promise<void> {
    const session = this.current(request)
    if (session !== undefined) await this.revoke(session)
  }

  private current(request: ConnectionTrustRequest): WecomSessionRecord | undefined {
    if (this.state === undefined || this.lifetime.signal.aborted) return undefined
    try { this.authority(request) } catch (_invalidAuthority) { return undefined }
    const payload = readCookie(cookie(request, SESSION_COOKIE), this.state.secret,
      this.config.publicOrigin, Date.now(), this.config.sessionTtlMs)
    const session = payload === undefined ? undefined : this.state.domain.table('sessions').get(payload.sessionId)
    if (session === undefined || payload === undefined || session.agentId !== this.config.agentId
      || session.browserAuthority !== payload.authority
      || session.issuedAt !== payload.issuedAt || session.expiresAt !== payload.expiresAt
      || session.revokedAt !== undefined || this.revoked.has(session.id) || session.expiresAt <= Date.now()) return undefined
    const identity = this.state.domain.table('identities').get(session.identityId)
    return identity?.enabled === true && identity.corpId === this.config.corpId ? session : undefined
  }

  /** Ensure one durable default Workspace exists for a member. */
  private async ensureWorkspace(identityId: WecomIdentityId): Promise<Workspace | undefined> {
    const registry = this.owner.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const existing = this.workspaces.get(identityId)
    if (existing !== undefined && registry.get(existing.id) !== undefined) {
      this.workspaceRoots.set(identityId, realpathSync(existing.path))
      return existing
    }
    const path = join(this.workspaceRoot, identityId)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const root = realpathSync(path)
    this.workspaceRoots.set(identityId, root)
    const workspace = await registry.create(root, 'default')
    this.workspaces.set(identityId, workspace)
    return workspace
  }

  /** Compute all Remote grants for one authenticated member. */
  private bindings(principal: CompanyUserPrincipal): readonly RemoteAccessBinding[] {
    const own = this.workspaceBindings(principal.identityId)
    return own.length === 0 ? own : [...own, ...[...this.resources].flatMap(provider => provider.bindings(principal))]
  }

  private workspaceBindings(identityId: WecomIdentityId): readonly RemoteAccessBinding[] {
    const state = this.state
    const identity = state?.domain.table('identities').get(identityId)
    const registry = this.owner.get('workspaceRegistry')
    if (state === undefined || registry === undefined) return []
    const gateway = this.gatewayIdentities.get(identityId)
    const localActive = identity?.enabled === true && identity.corpId === this.config.corpId
      && [...state.domain.table('sessions').entries()].some(([id, session]) => session.identityId === identityId
        && session.agentId === this.config.agentId && session.browserAuthority === this.config.publicOrigin
        && !this.revoked.has(id) && session.revokedAt === undefined && session.expiresAt > Date.now())
    if (gateway === undefined && !localActive) return []
    const root = this.workspaceRoots.get(identityId)
    if (root === undefined) return []
    const workspace = this.workspaces.get(identityId)
    if (workspace === undefined || registry.get(workspace.id) === undefined || !this.pathWithin(root, workspace.path)) return []
    const sessionIds = [...workspace.sessionIds]
    const actions: readonly RemoteAccessAction[] = [
      'commands/list', 'fileUploads/upload', 'goals/get', 'session/list', 'session/search', 'session/control',
      'session/create', 'workspace/follow', 'workspace/archiveSession', 'workspace/unarchiveSession',
      'workspace/pinSession', 'workspace/unpinSession', 'workspace/insertSessionBefore',
      'session/cancel', 'session/events', 'session/follow', 'session/fork', 'session/observeEvent',
      'session/observeProjections', 'session/observeState', 'session/page', 'session/prompt',
      'session/attachment',
      'session/projections', 'session/rename', 'session/selectModel', 'session/state', 'session/updateQueue',
      'session/wait', 'agentPresets/select', 'skills/list', 'toolResults/watch', 'workspaceFiles/read', 'workspaceFiles/readBytes',
      'workspaceFiles/stat', 'workspaceFiles/list', 'workspaceFiles/changes',
      'event:api-session/activity', 'event:api-session/added', 'event:api-session/error',
      'event:api-session/removed', 'event:api-session/status',
    ]
    const bindings: RemoteAccessBinding[] = [{
      role: { name: 'wecom:global', resource: 'global', actions: [
        'agentPresets/list', 'agentPresets/read', 'agentPresets/select',
        'credentials/describe', 'credentials/set', 'credentials/unset',
        'dynamicCordisRunner/inventory', 'dynamicCordisRunner/syncInspectManifest',
        'llm/discoverModels', 'llm/listProviders', 'llm/listConfigurableProviders',
        'pluginInventory/list', 'pluginManager/listBundles', 'pluginManager/listPlugins',
        'pluginManager/listVersionExemptions', 'pluginManager/listVersions', 'pluginManager/readBundleDetail',
        'pluginManager/registries', 'pluginManager/inspect', 'pluginManager/setPluginEnabled',
        'pluginManager/setBundleEnabled', 'pluginManager/installBundle', 'pluginManager/updateBundle',
        'pluginManager/waitForInstall', 'pluginManager/cancelInstall', 'pluginManager/removeBundle',
        'pluginMarket/listIndexes', 'pluginMarket/setIndexes', 'pluginMarket/search', 'pluginMarket/readEntryDetail',
        'pluginRegistryProbe/fastest', 'permissionPresets/catalog',
        'settings/describe', 'settings/update', 'settings/replace', 'settings/mutate', 'settings/openSettingsDocument',
        'session/canOpenWorkspacePath', 'session/control', 'session/create', 'session/list', 'session/modelCatalog',
        'session/search', 'workspace/follow',
        'event:settings/document-updated', 'event:credentials/reference-updated', 'event:credentials/record-updated',
        'event:agent-preset/selected',
        'event:llm/adapters-updated', 'event:llm/models-updated', 'event:permission-presets/catalog-changed',
        'event:plugin-manager/changed', 'event:plugin-manager/install-log', 'event:plugin-manager/install-state',
        'event:plugin-manager/update-state', 'event:plugin-market/changed',
      ] },
      resource: { kind: 'global' },
      condition: ({ action, args }: Parameters<RemoteAccessCondition<'global'>>[0]): RemoteAccessDecision =>
        action === 'session/create' ? this.canCreateSession(workspace, args) : { kind: 'allow' },
    }]
    for (const id of sessionIds) {
      bindings.push({ role: { name: 'wecom:session', resource: 'session', actions }, resource: { kind: 'session', id } })
      bindings.push({
        role: { name: 'wecom:commands', resource: 'session', actions: ['commands/execute'] },
        resource: { kind: 'session', id },
        condition: ({ args }: Parameters<RemoteAccessCondition<'session'>>[0]): RemoteAccessDecision =>
          args === undefined || (typeof args.line === 'string' && (/^(?:\/(?:permission|compact|goal|plan))(?:\s|$)/u.test(args.line)
              || [...this.resources].some(provider => provider.defaultWorkspaceCommands?.some(command => args.line === `/${command}` || (typeof args.line === 'string' && args.line.startsWith(`/${command} `))))))
            ? { kind: 'allow' } : { kind: 'deny', reason: 'command-not-granted' },
      })
    }
    bindings.push({
      role: { name: 'wecom:workspace', resource: 'workspace', actions: [
        'workspace/follow', 'workspace/insertSessionBefore', 'session/create',
      ] },
      resource: { kind: 'workspace', id: workspace.id },
      condition: ({ action, args }: Parameters<RemoteAccessCondition<'workspace'>>[0]): RemoteAccessDecision =>
        action === 'session/create' ? this.canCreateSession(workspace, args) : { kind: 'allow' },
    })
    return bindings
  }

  private canCreateSession(workspace: Workspace, args: Readonly<Record<string, unknown>> | undefined): RemoteAccessDecision {
    if (args === undefined) return { kind: 'allow' }
    const request = args.request
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return { kind: 'deny', reason: 'invalid-request' }
    }
    const input = request as { readonly workspaceId?: string; readonly cwd?: string; readonly sessionId?: string }
    if (input.cwd !== undefined) return { kind: 'deny', reason: 'cwd-not-allowed' }
    if (input.workspaceId !== workspace.id) return { kind: 'deny', reason: 'workspace-not-owned' }
    const sessionId = input.sessionId
    if (sessionId !== undefined && !workspace.sessionIds.some(id => String(id) === sessionId)) {
      return { kind: 'deny', reason: 'session-not-owned' }
    }
    return { kind: 'allow' }
  }

  private pathWithin(root: string, path: string): boolean {
    const child = relative(root, resolve(path))
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  }

  private async revoke(session: WecomSessionRecord): Promise<void> {
    this.revoked.add(session.id)
    this.owner.get('remoteAccess')?.invalidate()
    await this.registration?.revoke(brandString<BrowserSessionKey>(session.id))
    await this.requireState().domain.table('sessions').put(session.id, { ...session, revokedAt: session.revokedAt ?? Date.now() })
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer)
    if (this.lifetime.signal.aborted) return
    const sessions = [...this.requireState().domain.table('sessions').entries()].map(([, session]) => session)
      .filter(session => session.revokedAt === undefined && !this.revoked.has(session.id))
    if (sessions.length === 0) return
    this.timer = setTimeout(() => {
      void this.track((async () => {
        for (const session of sessions) if (session.expiresAt <= Date.now()) await this.revoke(session)
      })().catch((_expiryPersistenceFailure: unknown) => {
        this.owner.logger.warn('wecom-auth: expired session revocation could not be saved; restore storage before restarting')
      }).finally(() => { this.scheduleExpiry() }))
    }, Math.max(1, Math.min(2147483647, Math.min(...sessions.map(session => session.expiresAt)) - Date.now())))
    this.timer.unref()
  }

  private authority(request: ConnectionTrustRequest): void {
    if (header(request, 'host') !== new URL(this.config.publicOrigin).host) throw new WecomAuthError('wecom-auth/forbidden', 403)
  }

  private requireState(): State {
    if (this.state === undefined) throw new WecomAuthError('wecom-auth/unavailable', 503)
    return this.state
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.active.add(task)
    void task.then(() => { this.active.delete(task) }, () => { this.active.delete(task) })
    return task
  }

  private async handle(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // OAuth navigates from WeCom's origin. The callback still checks Host and browser-bound state;
      // cross-origin Fetch requests (with Origin) retain Connection's ordinary cross-site refusal.
      const trustRequest = path === '/auth/wecom/callback' && req.method === 'GET' && header(req, 'origin') === undefined
        ? { headers: { ...req.headers, 'sec-fetch-site': 'none' } } : req
      if (this.owner.connection.trustRejection(trustRequest) !== undefined) throw new WecomAuthError('wecom-auth/forbidden', 403)
      this.authority(req)
      const method = path === '/auth/wecom/logout' ? 'POST' : 'GET'
      if (req.method !== method) { res.writeHead(405, { allow: method }); res.end(); return }
      if (method === 'POST' && (header(req, 'x-dsh-auth') !== '1' || header(req, 'origin') !== this.config.publicOrigin)) {
        throw new WecomAuthError('wecom-auth/forbidden', 403)
      }
      const url = new URL(req.url ?? '/', this.config.publicOrigin)
      const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
      if (path === '/login') {
        const nonce = randomBytes(32).toString('base64url')
        const gatewayCurrent = this.gatewayPrincipal(req) === undefined ? null : this.getCurrentSession(req)
        const current = url.searchParams.get('account') === '1' ? gatewayCurrent ?? this.getCurrentSession(req) : null
        if (current !== null) {
          res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'` })
          res.end(accountPage(current, nonce, /^zh\b/i.test(header(req, 'accept-language') ?? '') ? 'zh' : 'en')); return
        }
        if (gatewayCurrent !== null) {
          const redirect = safeRedirect(url.searchParams.get('redirect'), ['/'])
          res.writeHead(303, { ...headers, location: redirect }); res.end(); return
        }
        const existing = cookie(req, BROWSER_COOKIE)
        const binding = existing !== undefined && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomBytes(32).toString('base64url')
        const attempt = await this.beginLogin(req, binding, url.searchParams.get('redirect'))
        const oauth = new URL('https://open.weixin.qq.com/connect/oauth2/authorize')
        oauth.search = new URLSearchParams({ appid: attempt.corpId, agentid: attempt.agentId, redirect_uri: attempt.redirectUri,
          response_type: 'code', scope: 'snsapi_base', state: attempt.state }).toString()
        oauth.hash = 'wechat_redirect'
        const bindingCookie = cookieHeader(BROWSER_COOKIE, binding, true, this.config.loginAttemptTtlMs, '/')
        if (/wxwork/i.test(header(req, 'user-agent') ?? '')) {
          res.writeHead(302, { ...headers, location: oauth.toString(), 'set-cookie': bindingCookie }); res.end(); return
        }
        res.writeHead(200, { ...headers, 'set-cookie': bindingCookie, 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}' https://wwcdn.weixin.qq.com; style-src 'unsafe-inline'; img-src data:; frame-src https://*.work.weixin.qq.com https://*.weixin.qq.com; base-uri 'none'; frame-ancestors 'none'` })
        res.end(loginPage(attempt, nonce, /^zh\b/i.test(header(req, 'accept-language') ?? '') ? 'zh' : 'en')); return
      }
      if (path === '/auth/wecom/callback') {
        if (url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1) throw new WecomAuthError('wecom-auth/invalid-request', 400)
        const result = await this.exchange(req, { code: url.searchParams.get('code'), state: url.searchParams.get('state') })
        const clearOwner = this.owner.connection.clearOwnerCookie(req)
        res.writeHead(303, { ...headers, location: result.redirect,
          'set-cookie': clearOwner === undefined ? result.cookie : [result.cookie, clearOwner] }); res.end(); return
      }
      if (path === '/auth/wecom/logout') {
        await this.logout(req)
        res.writeHead(200, { ...headers, 'content-type': 'application/json', 'set-cookie': cookieHeader(SESSION_COOKIE, '', true, 0, '/') })
        res.end('{"ok":true}'); return
      }
      const session = this.getCurrentSession(req)
      res.writeHead(session === null ? 401 : 200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ session }))
    } catch (error) {
      const failure = error instanceof WecomAuthError ? error : new WecomAuthError('wecom-auth/unavailable', 503)
      if (failure.status >= 500) this.owner.logger.warn('wecom-auth: login/session operation failed (%s); check WeCom configuration and storage', failure.code)
      res.writeHead(failure.status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: failure.code, message: 'Sign-in failed. Start a new login; contact your administrator if it persists.' }))
    }
  }
}

export default CompanyWecomAuthService
