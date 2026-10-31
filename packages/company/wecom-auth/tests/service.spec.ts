/** Real HTTP admission with only official external API calls mocked. */
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import Auth, { Config } from '../src/index.ts'
import { WecomOfficial } from '../src/upstream.ts'
import type {} from '../src/types.ts'
import type { WecomLoginConfig } from '../src/types.ts'

const publicOrigin = 'https://login.example'
const config = Config({ corpId: 'wwfixture', agentId: '1000239', publicOrigin } as Config)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

function officialFixture() {
  const nativeFetch = globalThis.fetch
  const calls: URL[] = []
  const overrides = new Map<string, unknown>()
  const responses: Record<string, object> = {
    '/gettoken': { access_token: 'PRIVATE_APP_TOKEN', expires_in: 7200 },
    '/auth/getuserinfo': { userid: 'member', user_ticket: 'PRIVATE_TICKET' },
    '/user/get': { userid: 'member', name: 'Member', department: [3], status: 1 },
    '/agent/get': { agentid: 1000239, allow_userinfos: { user: [{ userid: 'member' }] } },
    '/department/list': { department: [{ id: 3, parentid: 2 }, { id: 2, parentid: 1 }, { id: 1, parentid: 0 }] },
    '/tag/get': { userlist: [], partylist: [2] },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname !== 'qyapi.weixin.qq.com') return nativeFetch(input, init)
    calls.push(url)
    const path = url.pathname.replace('/cgi-bin', '')
    const response = path === '/gettoken' ? responses[path] : { errcode: 0, ...responses[path] }
    return new Response(JSON.stringify(overrides.get(path) ?? response), { headers: { 'content-type': 'application/json' } })
  }))
  return { calls, overrides }
}

async function fixture(overrides: Partial<{ gatewayIdentityEnabled: boolean; gatewayLogoutUrl: string }> = {}) {
  vi.stubEnv('DSH_WECOM_APP_SECRET', 'PRIVATE_TEST_SECRET')
  const official = officialFixture()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  new MemoryCredentials(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('test', backend)
  ctx.provide(storageBackendServiceKey('test'), backend)
  await ctx.plugin(StorageDomain, { backend: 'test' })
  const storedHeaders: Array<{
    header: { version: 4; id: SessionId; createdAt: number; cwd: string; isSeeded: false }
    revision: number
  }> = []
  ctx.provide('sessionPersistence', { list: async () => storedHeaders } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  new RemoteAccessService(ctx)
  await ctx.plugin(Connection, { trustedHosts: ['login.example'], requireBrowserLogin: true })
  const fiber = ctx.plugin(Auth, Config({ ...config, ...overrides } as Config))
  await fiber
  ctx.effect(() => ctx.webServer.registerFallback((req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('APPLICATION') }
  }))
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest(ctx.webServer.getOrigin() + path, {
      method: init.method ?? 'GET', headers: { host: 'login.example', ...Object.fromEntries(new Headers(init.headers)) },
    }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
      incoming.on('end', () => {
        const headers = new Headers()
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i] ?? '', incoming.rawHeaders[i + 1] ?? '')
        }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500, headers }))
      })
      incoming.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
  const begin = async (redirect = '/') => {
    const page = await request('/login?redirect=' + encodeURIComponent(redirect))
    expect(page.status).toBe(200)
    const body = await page.text()
    const match = body.match(/const config=(.*);/)
    if (match?.[1] === undefined) throw new Error('Missing QR configuration')
    const attempt = JSON.parse(match[1]) as WecomLoginConfig
    const binding = page.headers.get('set-cookie')?.split(';')[0]
    if (binding === undefined) throw new Error('Missing browser binding')
    return { attempt, binding }
  }
  const exchange = (attempt: Awaited<ReturnType<typeof begin>>, state = attempt.attempt.state, binding = attempt.binding) => request(
    '/auth/wecom/callback?' + new URLSearchParams({ code: 'PRIVATE_CODE', state }), { headers: { cookie: binding } })
  return { ctx, fiber, request, begin, exchange, warnings, storedHeaders, ...official }
}

it('admits a trusted gateway identity and exposes its configured logout destination', async () => {
  const f = await fixture({ gatewayIdentityEnabled: true, gatewayLogoutUrl: 'https://portal.example/logout' })
  const gatewayHeaders = { host: 'login.example', 'x-user-info': encodeURIComponent(JSON.stringify({ userId: 'portal-user', userName: 'Portal User', department: 'ops' })) }
  const admitted = f.ctx.connection.admit({ headers: gatewayHeaders })
  if (!('peer' in admitted)) throw new Error('Expected gateway Peer')
  expect(admitted.peer.principal.kind).toBe('gateway-user')
  const me = await f.request('/auth/me', { headers: gatewayHeaders })
  expect(me.status).toBe(200)
  expect(await me.json()).toMatchObject({ session: { userId: 'portal-user', displayName: 'Portal User', logoutUrl: 'https://portal.example/logout' } })
  await vi.waitFor(() => { expect(f.ctx.workspaceRegistry.list()).toHaveLength(1) })
  expect(f.ctx.remoteAccess.decide({ principal: admitted.peer.principal, action: 'agentPresets/list', resources: [{ kind: 'global' }] })).toEqual({ kind: 'allow' })
  const account = await f.request('/login?account=1', { headers: gatewayHeaders })
  expect(await account.text()).toContain('https://portal.example/logout')
})

it('falls back to WeCom OAuth when gateway identity is enabled but the request has no gateway header', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  onTestFinished(() => { stdout.mockRestore() })
  const f = await fixture({ gatewayIdentityEnabled: true, gatewayLogoutUrl: 'https://portal.example/logout' })
  const { attempt } = await f.begin()
  expect(attempt.state).toEqual(expect.any(String))
  expect((await f.request('/auth/me')).status).toBe(401)
  expect(stdout).toHaveBeenCalledWith('wecom-auth: gateway X-User-Info header missing\n')
})

it('redirects protected root, offers desktop QR and automatically authorizes a WeCom browser', async () => {
  const f = await fixture()
  const root = await f.request('/?tab=mine&token=private')
  expect(root.status).toBe(302)
  expect(root.headers.get('location')).toBe('/login?redirect=%2F%3Ftab%3Dmine')
  const desktop = await f.request('/login', { headers: { 'accept-language': 'zh-CN' } })
  const html = await desktop.text()
  expect(html).toContain('企业数字化门户')
  expect(html).toContain('扫码登录')
  expect(html).toContain('data:image/jpeg;base64,')
  expect(html).toContain('id="qr"')
  expect(html).not.toContain('密码登录')
  expect(html).not.toContain('验证码登录')
  expect(desktop.headers.get('content-security-policy')).toContain('img-src data:')
  const result = await f.request('/login?redirect=%2Freports', { headers: { 'user-agent': 'MicroMessenger wxwork' } })
  expect(result.status).toBe(302)
  const url = new URL(result.headers.get('location') ?? '')
  expect(url.origin).toBe('https://open.weixin.qq.com')
  expect(url.searchParams.get('scope')).toBe('snsapi_base')
  expect(url.searchParams.get('redirect_uri')).toBe(publicOrigin + '/auth/wecom/callback')
  expect(url.searchParams.get('appid')).toBe('wwfixture')
  expect(result.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Secure')
})

it('binds state to a browser, consumes once and preserves only local redirects', async () => {
  const f = await fixture()
  const attempt = await f.begin('/reports?tab=mine&token=secret')
  expect((await f.exchange(attempt, attempt.attempt.state, 'dsh-wecom-browser=wrong')).status).toBe(400)
  expect((await f.exchange(attempt, 'bad-state')).status).toBe(400)
  expect(f.calls).toHaveLength(0)
  const result = await f.exchange(attempt)
  expect(result.status).toBe(303)
  expect(result.headers.get('location')).toBe('/reports?tab=mine')
  expect(result.headers.get('set-cookie')).not.toMatch(/PRIVATE_|access_token/)
  expect((await f.exchange(attempt)).status).toBe(400)
  expect(f.calls.filter(url => url.pathname.endsWith('/auth/getuserinfo'))).toHaveLength(1)
  const unsafe = await f.exchange(await f.begin('https://attacker.invalid/'))
  expect(unsafe.headers.get('location')).toBe('/')
  expect(f.calls.filter(url => url.pathname.endsWith('/gettoken'))).toHaveLength(1)
})

it('accepts browser-bound cross-site OAuth navigation but rejects foreign Origin fetches', async () => {
  const f = await fixture()
  const attempt = await f.begin()
  const path = '/auth/wecom/callback?' + new URLSearchParams({ code: 'PRIVATE_CODE', state: attempt.attempt.state })
  expect((await f.request(path, { headers: { cookie: attempt.binding, origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  expect(f.calls).toHaveLength(0)
  expect((await f.request(path, { headers: { cookie: attempt.binding, 'sec-fetch-site': 'cross-site' } })).status).toBe(303)
})

it('bounds concurrent login attempts before asynchronous storage writes', async () => {
  const f = await fixture()
  await f.fiber.dispose()
  await f.ctx.plugin(Auth, { ...config, maxLoginAttempts: 1 })
  const results = await Promise.all([f.request('/login'), f.request('/login')])
  expect(results.map(result => result.status).sort()).toEqual([200, 429])
})

it('establishes distinct member Peers and revokes sessions and streams on logout', async () => {
  const f = await fixture()
  const result = await f.exchange(await f.begin())
  const cookie = result.headers.getSetCookie()[0]?.split(';')[0]
  if (cookie === undefined) throw new Error('Missing session cookie')
  const headers = { host: 'login.example', cookie }
  const admitted = f.ctx.connection.admit({ headers })
  if (!('peer' in admitted)) throw new Error('Expected member Peer')
  expect(admitted.peer.principal.kind).toBe('wecom-user')
  if (admitted.peer.principal.kind !== 'wecom-user') throw new Error('Expected WeCom principal')
  expect(admitted.peer.principal.role).toBe('user')
  const workspace = f.ctx.workspaceRegistry.list()[0]
  expect(workspace?.title).toBe('default')
  expect(workspace?.path).toContain('i-')
  const grants = f.ctx.remoteAccess.snapshotFor(admitted.peer.principal)
  expect(grants.type).toBe('baseline')
  if (grants.type !== 'baseline' || grants.owner) throw new Error('Expected member access baseline')
  expect(grants.grants.some(grant => grant.resource.kind === 'workspace' && grant.resource.id === workspace?.id)).toBe(true)
  expect(f.ctx.connection.admit({ headers })).toEqual(admitted)
  expect(f.ctx.connection.requestRejection({ headers })).toBe(403)
  expect((await f.request('/', { headers: { cookie } })).status).toBe(200)
  const me = await f.request('/auth/me', { headers: { cookie } })
  expect(me.status).toBe(200)
  expect(await me.text()).toContain('member')
  const account = await f.request('/login?account=1', { headers: { cookie, 'accept-language': 'zh-CN' } })
  expect(account.status).toBe(200)
  const accountBody = await account.text()
  expect(accountBody).toContain('Member')
  expect(accountBody).toContain('普通用户')
  expect((await f.request('/auth/wecom/logout', { method: 'POST', headers: { cookie } })).status).toBe(403)
  const logout = await f.request('/auth/wecom/logout', { method: 'POST', headers: { cookie, origin: publicOrigin, 'x-dsh-auth': '1' } })
  expect(logout.status).toBe(200)
  expect(admitted.peer.signal.aborted).toBe(true)
  expect(f.ctx.connection.admit({ headers })).toEqual({ rejection: 401 })
})


it('isolates each member to one default Workspace and its Sessions', async () => {
  const f = await fixture()
  const first = await f.exchange(await f.begin())
  const firstCookie = first.headers.getSetCookie()[0]?.split(';')[0]
  if (firstCookie === undefined) throw new Error('Missing first member session cookie')
  const firstWorkspace = f.ctx.workspaceRegistry.list()[0]
  if (firstWorkspace === undefined) throw new Error('Missing first member Workspace')
  const firstSessionId = brandString<SessionId>('session-wecom-first')
  f.storedHeaders.push({
    header: { version: 4, id: firstSessionId, createdAt: Date.now(), cwd: firstWorkspace.path, isSeeded: false }, revision: 1,
  })
  await firstWorkspace.attachSession(firstSessionId)

  f.overrides.set('/auth/getuserinfo', { userid: 'other', user_ticket: 'PRIVATE_TICKET' })
  f.overrides.set('/user/get', { userid: 'other', name: 'Other', department: [3], status: 1 })
  f.overrides.set('/agent/get', { agentid: 1000239, allow_userinfos: { user: [{ userid: 'other' }] } })
  const second = await f.exchange(await f.begin())
  const secondCookie = second.headers.getSetCookie()[0]?.split(';')[0]
  if (secondCookie === undefined) throw new Error('Missing second member session cookie')
  const workspaces = f.ctx.workspaceRegistry.list()
  expect(workspaces).toHaveLength(2)
  const secondWorkspace = workspaces.find(workspace => workspace.id !== firstWorkspace.id)
  if (secondWorkspace === undefined) throw new Error('Missing second member Workspace')
  const secondSessionId = brandString<SessionId>('session-wecom-second')
  f.storedHeaders.push({
    header: { version: 4, id: secondSessionId, createdAt: Date.now(), cwd: secondWorkspace.path, isSeeded: false }, revision: 2,
  })
  await secondWorkspace.attachSession(secondSessionId)

  const firstRequest = { headers: { host: 'login.example', cookie: firstCookie } }
  const secondRequest = { headers: { host: 'login.example', cookie: secondCookie } }
  const firstPeer = f.ctx.connection.admit(firstRequest)
  const secondPeer = f.ctx.connection.admit(secondRequest)
  if (!('peer' in firstPeer) || !('peer' in secondPeer)) throw new Error('Expected both member Peers')
  const firstPrincipal = firstPeer.peer.principal
  const secondPrincipal = secondPeer.peer.principal
  const firstSnapshot = f.ctx.remoteAccess.snapshotFor(firstPrincipal)
  const secondSnapshot = f.ctx.remoteAccess.snapshotFor(secondPrincipal)
  expect(firstSnapshot.type).toBe('baseline')
  expect(secondSnapshot.type).toBe('baseline')
  if (firstSnapshot.type !== 'baseline' || secondSnapshot.type !== 'baseline' || firstSnapshot.owner || secondSnapshot.owner) {
    throw new Error('Expected non-owner access baselines')
  }
  expect(firstSnapshot.grants).toEqual(expect.arrayContaining([
    { resource: { kind: 'workspace', id: firstWorkspace.id }, actions: expect.any(Array) },
    { resource: { kind: 'session', id: firstSessionId }, actions: expect.any(Array) },
  ]))
  expect(firstSnapshot.grants).not.toEqual(expect.arrayContaining([
    { resource: { kind: 'workspace', id: secondWorkspace.id }, actions: expect.any(Array) },
    { resource: { kind: 'session', id: secondSessionId }, actions: expect.any(Array) },
  ]))
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'workspace/follow', resources: [{ kind: 'workspace', id: secondWorkspace.id }] })).toEqual({ kind: 'deny', reason: 'no-allow' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'session/control', resources: [{ kind: 'session', id: secondSessionId }] })).toEqual({ kind: 'deny', reason: 'no-allow' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'session/create', resources: [{ kind: 'global' }], args: { request: { workspaceId: secondWorkspace.id } } })).toEqual({ kind: 'deny', reason: 'workspace-not-owned' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'session/create', resources: [{ kind: 'global' }], args: { request: { cwd: secondWorkspace.path } } })).toEqual({ kind: 'deny', reason: 'cwd-not-allowed' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'session/create', resources: [{ kind: 'workspace', id: firstWorkspace.id }], args: { request: { workspaceId: firstWorkspace.id } } })).toEqual({ kind: 'allow' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'settings/describe', resources: [{ kind: 'global' }] })).toEqual({ kind: 'allow' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'agentPresets/list', resources: [{ kind: 'global' }] })).toEqual({ kind: 'allow' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'directoryPicker/list', resources: [{ kind: 'global' }], args: { path: firstWorkspace.path } })).toEqual({ kind: 'deny', reason: 'no-allow' })
  expect(f.ctx.remoteAccess.decide({ principal: firstPrincipal, action: 'workspace/create', resources: [{ kind: 'global' }], args: { request: { path: firstWorkspace.path } } })).toEqual({ kind: 'deny', reason: 'no-allow' })
})

it('keeps required admission closed after provider disposal and rejects Owner launch credentials', async () => {
  const f = await fixture()
  const ownerUrl = new URL(f.ctx.connection.authenticatedUrl(publicOrigin))
  expect((await f.request('/connect' + ownerUrl.search)).status).toBe(401)
  expect((await f.request('/' + ownerUrl.search)).status).toBe(302)
  await f.fiber.dispose()
  expect((await f.request('/' + ownerUrl.search)).status).toBe(401)
})

it.each([
  ['/auth/getuserinfo', { errcode: 0, openid: 'external', external_userid: 'external' }, 403],
  ['/auth/getuserinfo', { errcode: 0, UserId: 'legacy-field' }, 403],
  ['/user/get', { errcode: 0, userid: 'member', department: [3], enable: 0, status: 1 }, 403],
  ['/user/get', { errcode: 0, userid: 'member', department: [3], status: 2 }, 403],
  ['/agent/get', { errcode: 0, agentid: 1000239, allow_userinfos: { user: [{ userid: 'other' }] } }, 403],
  ['/gettoken', { errcode: 40013, errmsg: 'PRIVATE_REFUSAL' }, 502],
])('fails closed for refused official response %s', async (path, response, status) => {
  const f = await fixture()
  f.overrides.set(path, response)
  const result = await f.exchange(await f.begin())
  expect(result.status).toBe(status)
  expect(result.headers.get('set-cookie')).toBeNull()
  expect(await result.text()).not.toMatch(/PRIVATE_/)
  expect(JSON.stringify(f.warnings.mock.calls)).not.toMatch(/PRIVATE_/)
})

it.each([
  { allow_partys: { partyid: [2] } },
  { allow_tags: { tagid: [7] } },
])('verifies visibility through ancestor departments and tags', async (fields) => {
  const f = await fixture()
  f.overrides.set('/agent/get', { errcode: 0, agentid: 1000239, ...fields })
  expect((await f.exchange(await f.begin())).status).toBe(303)
  expect(f.calls.some(url => url.pathname.endsWith('/department/list'))).toBe(true)
})

it('restores local sessions after plugin reload and expires them without app-token credentials', async () => {
  const f = await fixture()
  const result = await f.exchange(await f.begin())
  const cookie = result.headers.getSetCookie()[0]?.split(';')[0]
  if (cookie === undefined) throw new Error('Missing session cookie')
  const request = { headers: { host: 'login.example', cookie } }
  await f.fiber.dispose()
  await f.ctx.plugin(Auth, config)
  expect(f.ctx.companyWecomAuth.getCurrentSession(request)).toMatchObject({ userId: 'member' })
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.sessionTtlMs + 1)
  expect(f.ctx.companyWecomAuth.getCurrentSession(request)).toBeNull()
  expect(f.ctx.connection.admit(request)).toEqual({ rejection: 401 })
})

it('rejects expired states and concurrent callback replay before an official exchange', async () => {
  const f = await fixture()
  const attempt = await f.begin()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.loginAttemptTtlMs + 1)
  expect((await f.exchange(attempt)).status).toBe(400)
  vi.restoreAllMocks()
  const fresh = await f.begin()
  const results = await Promise.all([f.exchange(fresh), f.exchange(fresh)])
  expect(results.map(result => result.status).sort()).toEqual([303, 400])
})

it('requires the server-only secret and never obtains it from plugin configuration', async () => {
  vi.stubEnv('DSH_WECOM_APP_SECRET', '')
  expect(() => new Auth(new Context(), config)).toThrow('DSH_WECOM_APP_SECRET')
})

it.each([undefined, 0])('accepts gettoken success with errcode %s', async (errcode) => {
  const f = officialFixture()
  if (errcode !== undefined) f.overrides.set('/gettoken', { errcode, access_token: 'PRIVATE_APP_TOKEN', expires_in: 7200 })
  const api = new WecomOfficial(config, 'TEST_SECRET', new AbortController().signal)
  await expect(api.exchange('code')).resolves.toMatchObject({ userId: 'member' })
  expect(f.calls).toHaveLength(4)
})

it.each([40013, '0', null, false])('rejects gettoken errcode %s before member lookup', async (errcode) => {
  const f = officialFixture()
  f.overrides.set('/gettoken', { errcode, access_token: 'PRIVATE_APP_TOKEN', expires_in: 7200 })
  const api = new WecomOfficial(config, 'TEST_SECRET', new AbortController().signal)
  await expect(api.exchange('code')).rejects.toMatchObject({ code: 'wecom-auth/remote-failure', status: 502 })
  expect(f.calls).toHaveLength(1)
})

it('rejects gettoken success without required token fields', async () => {
  const f = officialFixture()
  f.overrides.set('/gettoken', {})
  const api = new WecomOfficial(config, 'TEST_SECRET', new AbortController().signal)
  await expect(api.exchange('code')).rejects.toMatchObject({ code: 'wecom-auth/remote-failure', status: 502 })
  expect(f.calls).toHaveLength(1)
})

it('bounds official API responses and sanitizes network failures', async () => {
  const f = officialFixture()
  f.overrides.set('/gettoken', { errcode: 0, access_token: 'x'.repeat(500), expires_in: 7200 })
  const api = new WecomOfficial({ ...config, maxResponseBytes: 100 }, 'TEST_SECRET', new AbortController().signal)
  await expect(api.exchange('code')).rejects.toMatchObject({ code: 'wecom-auth/remote-failure' })
})
