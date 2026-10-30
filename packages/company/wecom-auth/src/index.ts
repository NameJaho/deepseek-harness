/** Official WeCom login and durable credential-free browser sessions. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { BrowserPrincipalRegistration, BrowserSessionKey, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { Config } from './config.ts'
import { wecomAuthDomain, type WecomSessionRecord } from './storage.ts'
import type { WecomIdentityId, WecomLoginAttemptId, WecomLoginConfig, WecomLoginResult, WecomSessionId, WecomSessionView } from './types.ts'
import { BROWSER_COOKIE, SESSION_COOKIE, cookie, cookieHeader, hash, hashMatches, header, readCookie, safeRedirect, signCookie } from './browser.ts'
import { WecomAuthError } from './errors.ts'
import { WecomOfficial, type WecomMemberLogin } from './upstream.ts'
import { loginPage } from './login-page.ts'

export { Config } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Official WeCom browser authentication; no app token or secret is exposed. */
    companyWecomAuth: CompanyWecomAuthService
  }
}

interface State { readonly domain: Domain<typeof wecomAuthDomain>; readonly secret: Buffer }
const SECRET = credentialKey('company-wecom-official-auth', 'cookie-secret')
const exchangeSchema = z.object({
  state: z.string().max(200).regex(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(4096),
}).strict()

/** Required browser login; local revocation stops admission before durable writes. */
export class CompanyWecomAuthService extends Service {
  static inject = ['credentials', 'storageDomain', 'connection', 'webServer']
  static Config = Config
  private readonly config: Config
  private readonly lifetime = new AbortController()
  private readonly upstream: WecomOfficial
  private state: State | undefined
  private registration: BrowserPrincipalRegistration | undefined
  private readonly active = new Set<Promise<unknown>>()
  private readonly consuming = new Set<WecomLoginAttemptId>()
  private pendingAttempts = 0
  private readonly revoked = new Set<WecomSessionId>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /** @param owner - Host HTTP, cookie-key and domain providers.
   * @param config - public application identifiers, HTTPS origin and limits.
   * @throws Error when identifiers, origin or the server app-secret environment are missing or invalid.
   */
  constructor(private readonly owner: Context, config: Config) {
    super(owner, 'companyWecomAuth')
    this.config = Config(config)
    const origin = new URL(this.config.publicOrigin)
    if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
      || origin.search !== '' || origin.hash !== '') throw new Error('wecom-auth: publicOrigin must be a bare HTTPS origin')
    this.config.publicOrigin = origin.origin
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
    this.registration = this.owner.connection.registerBrowserPrincipalProvider({
      loginPath: '/login', requireLogin: true,
      authenticate: (request) => {
        const session = this.current(request)
        const identity = session === undefined ? undefined : this.state?.domain.table('identities').get(session.identityId)
        if (session === undefined || identity === undefined) return undefined
        return { sessionKey: brandString<BrowserSessionKey>(session.id), principal: {
          kind: 'wecom-user', identityId: identity.id, corpId: identity.corpId, userId: identity.userId,
        } }
      },
    })
    this.owner.on('webserver/index-inject', (table, peer) => {
      if (peer.principal.kind !== 'wecom-user') return
      const identity = this.state?.domain.table('identities').get(peer.principal.identityId)
      if (identity !== undefined) table.push({ kind: 'global', name: '__DSH_WECOM_MEMBER__', value: {
        corpId: identity.corpId, userId: identity.userId, displayName: identity.displayName,
      } })
    })
    for (const path of ['/login', '/auth/wecom/callback', '/auth/wecom/logout', '/auth/me']) {
      this.owner.effect(() => this.owner.webServer.register({ kind: 'exact', path,
        handler: (request, response) => this.track(this.handle(path, request, response)),
      }), `wecom-auth: ${path}`)
    }
    this.scheduleExpiry()
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
    const previous = this.current(request)
    if (previous !== undefined) await this.revoke(previous)
    await state.domain.table('identities').put(identityId, identity)
    await state.domain.table('sessions').put(id, session)
    this.scheduleExpiry()
    return { session: { identityId, ...login, expiresAt: session.expiresAt }, redirect,
      cookie: cookieHeader(SESSION_COOKIE, signCookie({ version: 1, sessionId: id, authority: this.config.publicOrigin,
        issuedAt: now, expiresAt: session.expiresAt }, state.secret), true, this.config.sessionTtlMs, '/') }
  }

  /** Resolve only enabled, unexpired, unrevoked local sessions for this deployment.
   * @param request - browser cookie and authority.
   * @returns credential-free member view, or null when admission is denied.
   */
  getCurrentSession(request: ConnectionTrustRequest): WecomSessionView | null {
    const session = this.current(request)
    const identity = session === undefined ? undefined : this.state?.domain.table('identities').get(session.identityId)
    return identity === undefined || session === undefined ? null : { identityId: identity.id, corpId: identity.corpId,
      userId: identity.userId, ...identity.displayName === undefined ? {} : { displayName: identity.displayName },
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

  private async revoke(session: WecomSessionRecord): Promise<void> {
    this.revoked.add(session.id)
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
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}' https://wwcdn.weixin.qq.com; style-src 'unsafe-inline'; frame-src https://*.work.weixin.qq.com https://*.weixin.qq.com; base-uri 'none'; frame-ancestors 'none'` })
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
